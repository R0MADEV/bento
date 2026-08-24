// WebRTC P2P bridge to the phone, replacing Tailscale for reachability.
//
// This process is always the *offerer*: it creates the DataChannel and the
// SDP offer, and the phone's browser answers. Named `webrtc_bridge` (not
// `webrtc`) so nothing here shadows the `webrtc` crate itself in `use`
// paths.
//
// ICE is non-trickle (gather-then-send, like the webrtc-rs examples): we
// wait for gathering to finish before posting the SDP, so the signaling
// Worker only ever needs to relay one offer and one answer — no separate
// ICE-candidate channel.
//
// Once the DataChannel opens, it carries a small JSON envelope protocol
// (see `Envelope` below), not raw bytes: a browser page has no way to run
// its native `fetch`/`WebSocket`/`EventSource` over an arbitrary transport,
// so the phone side re-implements just enough of those APIs on top of
// this envelope (see WEBRTC_REMOTE.md, Fase 3) and this side turns each
// envelope back into a real request against the existing phone server —
// unmodified, exactly as if it were on the LAN. The target address is
// whatever `RemoteControl::status()` reports (not `127.0.0.1`): the phone
// server binds to a specific interface IP (Tailscale or LAN), not the
// loopback or wildcard address, so this must reach it the same way any
// other client on that network would.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use bytes::BytesMut;
use futures_util::{SinkExt, StreamExt};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use rtc::ice::mdns::MulticastDnsMode;
use webrtc::peer_connection::{
    register_default_interceptors, MediaEngine, PeerConnection, PeerConnectionBuilder,
    PeerConnectionEventHandler, RTCConfigurationBuilder, RTCIceGatheringState, RTCIceServer,
    RTCPeerConnectionIceEvent, RTCPeerConnectionState, RTCSessionDescription, Registry,
    SettingEngine,
};

const STUN_SERVER: &str = "stun:stun.l.google.com:19302";
// Free public TURN relay (Open Relay Project / Metered.ca) — fallback for
// when direct P2P can't establish (asymmetric NAT, routers without NAT
// hairpinning for same-LAN STUN, mDNS/Safari quirks, etc). This project has
// no VPS/budget for a private TURN server; this is the same static demo
// credential used by other open-source projects (e.g. Nextcloud Talk) that
// are in the same position. 20GB/month free, shared across everyone using
// it — best-effort, not a guarantee, but strictly better than STUN-only.
const TURN_SERVER: &str = "turn:openrelay.metered.ca:80";
const TURN_USERNAME: &str = "openrelayproject";
const TURN_CREDENTIAL: &str = "openrelayproject";
const SIGNALING_POLL_INTERVAL: Duration = Duration::from_secs(1);
const SIGNALING_TIMEOUT: Duration = Duration::from_secs(120);
// Matches the signaling Worker's PAIRING_TTL_SECONDS (workers/signaling/src/
// pairing.ts) — the code stays answerable for this long, not just once. A
// phone reloading the pairing page (accidental refresh, Safari backgrounding
// the tab, losing wifi, closing and reopening the app) re-fetches the same
// URL and re-answers; run_offerer loops to renegotiate a fresh SDP
// offer/answer each time instead of the caller needing a brand new code and
// QR scan every time within the same day.
const PAIRING_TTL: Duration = Duration::from_secs(24 * 60 * 60);
// ICE gathering across every local interface can stall indefinitely on one
// that never gets a STUN reply (observed with a Tailscale interface present:
// its virtual address never round-trips a STUN request). One usable
// candidate is enough to attempt a connection, so gathering is not worth
// blocking on forever — send whatever was gathered once this elapses.
// 8s (not 5s): the TURN relay candidate needs its own authenticated
// ALLOCATE round-trip on top of the plain STUN binding request, so it
// lands later — 5s was consistently cutting it off before it arrived.
const ICE_GATHERING_TIMEOUT: Duration = Duration::from_secs(8);

struct OfferHandler {
    gathering_complete: mpsc::Sender<()>,
    /// Fires once the connection reaches a terminal state (closed, failed,
    /// or disconnected) — the signal `run_offerer`'s outer loop waits on to
    /// know this round is over and it's time to renegotiate, if there's
    /// still time left on the pairing code.
    round_over: mpsc::Sender<()>,
    pairing_code: String,
    /// Unsolicited-event channel back to the IPC connection (same one
    /// `terminal.output`/`terminal.exit` use) — lets the desktop UI show a
    /// real connected/failed state instead of a static "esperando…" text.
    events: mpsc::UnboundedSender<String>,
}

#[async_trait]
impl PeerConnectionEventHandler for OfferHandler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.gathering_complete.try_send(());
        }
    }

    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        eprintln!(
            "[webrtc_bridge] ice candidate: type={} address={} (code={})",
            event.candidate.typ, event.candidate.address, self.pairing_code
        );
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        eprintln!("[webrtc_bridge] connection state -> {state} (code={})", self.pairing_code);
        let event = serde_json::json!({
            "event": "webrtc.status",
            "code": self.pairing_code,
            "state": state.to_string(),
        });
        let _ = self.events.send(event.to_string());

        // Disconnected is excluded on purpose: ICE retries automatically from
        // there and either recovers back to Connected or moves on to Failed
        // by itself (see RTCPeerConnectionState docs) — treating it as
        // terminal here would abandon a connection that was about to heal.
        let is_terminal = matches!(state, RTCPeerConnectionState::Closed | RTCPeerConnectionState::Failed);
        if is_terminal {
            let _ = self.round_over.try_send(());
        }
    }
}

/// Opens a P2P connection to the phone using `pairing_code` to find each other
/// via the signaling Worker at `signaling_base`, then bridges the resulting
/// DataChannel to the existing phone server at `local_addr` (its actual bound
/// `host:port`, from `RemoteControl::status()` — not `127.0.0.1`). The code
/// stays answerable for `PAIRING_TTL`, not just once: each time a round ends
/// (or nobody answers a given offer in time), a fresh SDP offer is posted
/// under the same code, so a phone reloading the pairing page later the same
/// day reconnects without a new QR scan. `events` carries connection-state
/// updates back to the IPC client (see `OfferHandler`).
pub async fn run_offerer(
    pairing_code: String,
    signaling_base: String,
    local_addr: String,
    events: mpsc::UnboundedSender<String>,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let deadline = tokio::time::Instant::now() + PAIRING_TTL;

    while tokio::time::Instant::now() < deadline {
        run_one_round(&pairing_code, &signaling_base, &local_addr, &events, &client, deadline).await?;
    }
    Ok(())
}

/// One offer→answer→bridge cycle. Returns once that connection ends (or the
/// deadline is reached first) so the caller can decide whether to loop again.
async fn run_one_round(
    pairing_code: &str,
    signaling_base: &str,
    local_addr: &str,
    events: &mpsc::UnboundedSender<String>,
    client: &reqwest::Client,
    deadline: tokio::time::Instant,
) -> Result<(), String> {
    let mut media_engine = MediaEngine::default();
    media_engine.register_default_codecs().map_err(|e| e.to_string())?;
    let registry = register_default_interceptors(Registry::new(), &mut media_engine).map_err(|e| e.to_string())?;

    let config = RTCConfigurationBuilder::new()
        .with_ice_servers(vec![
            RTCIceServer { urls: vec![STUN_SERVER.to_string()], ..Default::default() },
            RTCIceServer {
                urls: vec![TURN_SERVER.to_string()],
                username: TURN_USERNAME.to_string(),
                credential: TURN_CREDENTIAL.to_string(),
            },
        ])
        .build();

    let (gathering_complete_tx, mut gathering_complete_rx) = mpsc::channel(1);
    let (round_over_tx, mut round_over_rx) = mpsc::channel(1);
    let handler = Arc::new(OfferHandler {
        gathering_complete: gathering_complete_tx,
        round_over: round_over_tx,
        pairing_code: pairing_code.to_string(),
        events: events.clone(),
    });
    let runtime = webrtc::runtime::default_runtime().ok_or("no webrtc runtime available")?;

    // PeerConnectionBuilder defaults to MulticastDnsMode::Disabled, which
    // discards remote mDNS candidates outright. Safari obfuscates its own
    // "host" ICE candidates as `<uuid>.local` mDNS names for privacy — with
    // mDNS disabled those get thrown away, leaving only the srflx (STUN)
    // path, which many home routers can't hairpin for two devices on the
    // same LAN. QueryOnly resolves incoming mDNS candidates without
    // advertising our own (we don't need to hide the Mac's LAN IP).
    let mut setting_engine = SettingEngine::default();
    setting_engine.set_multicast_dns_mode(MulticastDnsMode::QueryOnly);

    let peer_connection = PeerConnectionBuilder::new()
        .with_configuration(config)
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .with_handler(handler)
        .with_runtime(runtime)
        .with_setting_engine(setting_engine)
        .with_udp_addrs(vec!["0.0.0.0:0".to_string()])
        .build()
        .await
        .map_err(|e| e.to_string())?;

    let data_channel = peer_connection.create_data_channel("bento", None).await.map_err(|e| e.to_string())?;
    tokio::spawn(bridge_data_channel(data_channel, local_addr.to_string()));

    let offer = peer_connection.create_offer(None).await.map_err(|e| e.to_string())?;
    peer_connection.set_local_description(offer).await.map_err(|e| e.to_string())?;
    // Best-effort: proceed with whatever candidates were gathered in time rather
    // than block forever on a straggling interface (see ICE_GATHERING_TIMEOUT).
    let _ = tokio::time::timeout(ICE_GATHERING_TIMEOUT, gathering_complete_rx.recv()).await;

    let local_description = peer_connection.local_description().await.ok_or("no local description after gathering")?;
    // Clear any answer left over from a previous round under this same code —
    // otherwise polling below could immediately read a stale answer that
    // doesn't match this round's fresh SDP (different ICE ufrag/pwd).
    delete_signaling(client, &format!("{signaling_base}/answer/{pairing_code}")).await;
    eprintln!("[webrtc_bridge] posting offer (code={pairing_code})");
    post_json(client, &format!("{signaling_base}/offer/{pairing_code}"), &local_description).await?;

    // The signaling store (Cloudflare KV) is eventually consistent — a write
    // here can take up to ~60s to become readable from the other side, so a
    // long wait here is expected, not a hang. Bounded by whichever is sooner:
    // SIGNALING_TIMEOUT (one round shouldn't wait forever) or the code's
    // overall deadline. Nobody answering in time isn't an error — it just
    // means try again with a fresh offer (the code is still valid).
    let round_deadline = deadline.min(tokio::time::Instant::now() + SIGNALING_TIMEOUT);
    let answer_url = format!("{signaling_base}/answer/{pairing_code}");
    let Some(answer): Option<RTCSessionDescription> = poll_until_deadline(client, &answer_url, round_deadline).await?
    else {
        return Ok(());
    };
    peer_connection.set_remote_description(answer).await.map_err(|e| e.to_string())?;
    eprintln!("[webrtc_bridge] SDP exchange complete, awaiting ICE/DTLS (code={pairing_code})");

    // Hold the connection open until it ends (closed/failed) or the code's
    // overall deadline passes — dropping `peer_connection` before then would
    // tear down a session that's still in use.
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    let _ = tokio::time::timeout(remaining, round_over_rx.recv()).await;
    Ok(())
}

async fn post_json<T: serde::Serialize>(client: &reqwest::Client, url: &str, body: &T) -> Result<(), String> {
    let response = client.post(url).json(body).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("signaling POST {url} failed: {}", response.status()));
    }
    Ok(())
}

/// Best-effort: a stale answer that fails to delete just risks being read
/// once more next round, not a broken session, so this doesn't propagate
/// errors — the caller doesn't need to abandon pairing over it.
async fn delete_signaling(client: &reqwest::Client, url: &str) {
    let _ = client.delete(url).send().await;
}

/// Polls `url` until it returns 200 (the peer has posted their side of the
/// handshake) or `deadline` passes — `None` in the latter case, not an
/// error, since the caller may just retry with a fresh offer.
async fn poll_until_deadline<T: DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    deadline: tokio::time::Instant,
) -> Result<Option<T>, String> {
    loop {
        let response = client.get(url).send().await.map_err(|e| e.to_string())?;
        if response.status().is_success() {
            return response.json::<T>().await.map(Some).map_err(|e| e.to_string());
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(None);
        }
        tokio::time::sleep(SIGNALING_POLL_INTERVAL).await;
    }
}

/// One message of the DataChannel's wire protocol. The phone side speaks the
/// same shape in JS (see `workers/signaling/` companion docs in
/// WEBRTC_REMOTE.md) — `Http`/`WsOpen`/`WsMessage`/`WsClose`/`SseOpen` arrive
/// from the phone; everything else is this side answering.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum Envelope {
    Http { id: String, method: String, path: String, #[serde(default)] headers: HashMap<String, String>, body: Option<String> },
    HttpResponse { id: String, status: u16, body: Option<String> },
    WsOpen { id: String, path: String },
    WsOpenAck { id: String },
    // rename needed: rename_all = "kebab-case" above would otherwise turn
    // this into "is-text" in the JSON, but the browser side (pairAssets.ts)
    // reads/writes camelCase "isText" — the mismatch silently made every
    // ws-message look like binary data to the browser (isText read back as
    // undefined/falsy) and likely failed to deserialize at all in the other
    // direction (keystrokes), since "is-text" would just be a missing field.
    WsMessage { id: String, data: String, #[serde(rename = "isText")] is_text: bool },
    WsClose { id: String },
    WsError { id: String },
    SseOpen { id: String, path: String },
    SseMessage { id: String, data: String },
    SseClose { id: String },
    SseError { id: String },
}

type WsSenders = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<WsMessage>>>>;

/// Reads envelopes off the DataChannel and turns each into a real request
/// against the phone server at the resolved `addr` (see `RemoteControl::status`), forwarding the result
/// back as an envelope. Requests run concurrently — a slow one (e.g. an SSE
/// stream) never blocks the next.
async fn bridge_data_channel(data_channel: Arc<dyn DataChannel>, local_addr: String) {
    let http_client = reqwest::Client::new();
    let ws_senders: WsSenders = Arc::new(Mutex::new(HashMap::new()));

    while let Some(event) = data_channel.poll().await {
        match event {
            DataChannelEvent::OnMessage(msg) => {
                let Ok(text) = std::str::from_utf8(&msg.data) else { continue };
                let Ok(envelope) = serde_json::from_str::<Envelope>(text) else { continue };
                tokio::spawn(handle_envelope(
                    envelope, data_channel.clone(), http_client.clone(), local_addr.clone(), ws_senders.clone(),
                ));
            }
            DataChannelEvent::OnClose => return,
            _ => {}
        }
    }
}

async fn handle_envelope(
    envelope: Envelope, data_channel: Arc<dyn DataChannel>, http_client: reqwest::Client,
    local_addr: String, ws_senders: WsSenders,
) {
    match envelope {
        Envelope::Http { id, method, path, headers, body } => {
            let request = HttpProxyRequest { id, method, path, headers, body };
            proxy_http(request, &data_channel, &http_client, local_addr).await;
        }
        Envelope::WsOpen { id, path } => {
            proxy_ws(id, path, data_channel, local_addr, ws_senders).await;
        }
        Envelope::WsMessage { id, data, is_text } => {
            forward_ws_send(&id, data, is_text, &ws_senders).await;
        }
        Envelope::WsClose { id } => {
            if let Some(sender) = ws_senders.lock().await.remove(&id) {
                let _ = sender.send(WsMessage::Close(None));
            }
        }
        Envelope::SseOpen { id, path } => {
            proxy_sse(id, path, data_channel, http_client, local_addr).await;
        }
        // Outbound-only — never arrives as an inbound message.
        Envelope::HttpResponse { .. }
        | Envelope::WsOpenAck { .. }
        | Envelope::WsError { .. }
        | Envelope::SseMessage { .. }
        | Envelope::SseClose { .. }
        | Envelope::SseError { .. } => {}
    }
}

async fn send_envelope(data_channel: &Arc<dyn DataChannel>, envelope: &Envelope) {
    if let Ok(json) = serde_json::to_string(envelope) {
        let _ = data_channel.send(BytesMut::from(json.as_bytes())).await;
    }
}

struct HttpProxyRequest {
    id: String,
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Option<String>,
}

async fn proxy_http(request: HttpProxyRequest, data_channel: &Arc<dyn DataChannel>, http_client: &reqwest::Client, local_addr: String) {
    let url = format!("http://{}{}", local_addr, request.path);
    let method = reqwest::Method::from_bytes(request.method.as_bytes()).unwrap_or(reqwest::Method::GET);
    let mut outgoing_request = http_client.request(method, url);
    for (name, value) in &request.headers {
        outgoing_request = outgoing_request.header(name, value);
    }
    if let Some(body) = request.body {
        outgoing_request = outgoing_request.body(body);
    }

    let id = request.id;
    let outgoing = match outgoing_request.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response.text().await.ok();
            Envelope::HttpResponse { id, status, body }
        }
        Err(_) => Envelope::HttpResponse { id, status: 502, body: None },
    };
    send_envelope(data_channel, &outgoing).await;
}

/// Opens a real WebSocket to the phone server and relays messages both ways
/// until either side closes it. `ws_senders` is how `WsMessage`/`WsClose`
/// envelopes arriving later (from the phone) find this connection again.
async fn proxy_ws(id: String, path: String, data_channel: Arc<dyn DataChannel>, local_addr: String, ws_senders: WsSenders) {
    let url = format!("ws://{local_addr}{path}");
    let Ok((stream, _)) = tokio_tungstenite::connect_async(url).await else {
        send_envelope(&data_channel, &Envelope::WsError { id }).await;
        return;
    };
    let (mut write, mut read) = stream.split();
    let (sender, mut receiver) = mpsc::unbounded_channel::<WsMessage>();
    ws_senders.lock().await.insert(id.clone(), sender);
    send_envelope(&data_channel, &Envelope::WsOpenAck { id: id.clone() }).await;

    let writer = tokio::spawn(async move {
        while let Some(message) = receiver.recv().await {
            let should_stop = matches!(message, WsMessage::Close(_));
            if write.send(message).await.is_err() || should_stop {
                break;
            }
        }
    });

    while let Some(Ok(message)) = read.next().await {
        let envelope = match message {
            WsMessage::Text(text) => Envelope::WsMessage { id: id.clone(), data: text.to_string(), is_text: true },
            WsMessage::Binary(data) => {
                Envelope::WsMessage { id: id.clone(), data: base64::engine::general_purpose::STANDARD.encode(data), is_text: false }
            }
            WsMessage::Close(_) => break,
            _ => continue,
        };
        send_envelope(&data_channel, &envelope).await;
    }

    ws_senders.lock().await.remove(&id);
    writer.abort();
    send_envelope(&data_channel, &Envelope::WsClose { id }).await;
}

async fn forward_ws_send(id: &str, data: String, is_text: bool, ws_senders: &WsSenders) {
    let Some(sender) = ws_senders.lock().await.get(id).cloned() else { return };
    let message = if is_text {
        WsMessage::Text(data)
    } else {
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else { return };
        WsMessage::Binary(bytes)
    };
    let _ = sender.send(message);
}

/// Proxies a Server-Sent Events stream: GETs `path` and re-emits each
/// `data:` event as an `SseMessage` envelope, exactly as the daemon's own
/// `text/event-stream` handlers produce them (`data: <json>\n\n`, one line).
async fn proxy_sse(id: String, path: String, data_channel: Arc<dyn DataChannel>, http_client: reqwest::Client, local_addr: String) {
    let url = format!("http://{local_addr}{path}");
    let Ok(response) = http_client.get(url).send().await else {
        send_envelope(&data_channel, &Envelope::SseError { id }).await;
        return;
    };

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    while let Some(Ok(chunk)) = stream.next().await {
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(data) = extract_sse_event(&mut buffer) {
            send_envelope(&data_channel, &Envelope::SseMessage { id: id.clone(), data }).await;
        }
    }
    send_envelope(&data_channel, &Envelope::SseClose { id }).await;
}

/// Pulls the first complete `\n\n`-terminated SSE event out of `buffer` (and
/// removes it), joining its `data:` line(s) into one string. Returns `None`
/// when the buffer holds no complete event yet — more bytes are expected.
fn extract_sse_event(buffer: &mut String) -> Option<String> {
    let end = buffer.find("\n\n")?;
    let raw: String = buffer.drain(..end + 2).collect();
    let data = raw
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(|value| value.strip_prefix(' ').unwrap_or(value))
        .collect::<Vec<_>>()
        .join("\n");
    Some(data)
}

#[cfg(test)]
mod envelope_tests {
    use super::extract_sse_event;

    #[test]
    fn extracts_a_single_line_event() {
        let mut buffer = "data: \"hello\"\n\n".to_string();
        assert_eq!(extract_sse_event(&mut buffer).as_deref(), Some("\"hello\""));
        assert_eq!(buffer, "");
    }

    #[test]
    fn joins_multiple_data_lines_with_newlines() {
        let mut buffer = "data: line one\ndata: line two\n\n".to_string();
        assert_eq!(extract_sse_event(&mut buffer).as_deref(), Some("line one\nline two"));
    }

    #[test]
    fn ignores_non_data_fields() {
        let mut buffer = "event: ping\nid: 1\ndata: payload\n\n".to_string();
        assert_eq!(extract_sse_event(&mut buffer).as_deref(), Some("payload"));
    }

    #[test]
    fn leaves_an_incomplete_trailing_event_in_the_buffer() {
        let mut buffer = "data: full\n\ndata: partial".to_string();
        assert_eq!(extract_sse_event(&mut buffer).as_deref(), Some("full"));
        assert_eq!(extract_sse_event(&mut buffer), None);
        assert_eq!(buffer, "data: partial");
    }

    #[test]
    fn drains_queued_events_one_call_at_a_time() {
        let mut buffer = "data: a\n\ndata: b\n\ndata: c\n\n".to_string();
        assert_eq!(extract_sse_event(&mut buffer).as_deref(), Some("a"));
        assert_eq!(extract_sse_event(&mut buffer).as_deref(), Some("b"));
        assert_eq!(extract_sse_event(&mut buffer).as_deref(), Some("c"));
        assert_eq!(extract_sse_event(&mut buffer), None);
    }
}
