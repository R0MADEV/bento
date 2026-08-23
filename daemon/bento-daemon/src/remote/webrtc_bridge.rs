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
// Once the DataChannel opens, it is bridged verbatim to a local TCP
// connection to the existing phone server (127.0.0.1:<port>) — this file
// never parses what flows through it.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::BytesMut;
use serde::de::DeserializeOwned;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::peer_connection::{
    register_default_interceptors, MediaEngine, PeerConnection, PeerConnectionBuilder,
    PeerConnectionEventHandler, RTCConfigurationBuilder, RTCIceGatheringState, RTCIceServer,
    RTCPeerConnectionState, RTCSessionDescription, Registry,
};

const STUN_SERVER: &str = "stun:stun.l.google.com:19302";
const SIGNALING_POLL_INTERVAL: Duration = Duration::from_secs(1);
const SIGNALING_TIMEOUT: Duration = Duration::from_secs(120);
// ICE gathering across every local interface can stall indefinitely on one
// that never gets a STUN reply (observed with a Tailscale interface present:
// its virtual address never round-trips a STUN request). One usable
// candidate is enough to attempt a connection, so gathering is not worth
// blocking on forever — send whatever was gathered once this elapses.
const ICE_GATHERING_TIMEOUT: Duration = Duration::from_secs(5);

struct OfferHandler {
    gathering_complete: mpsc::Sender<()>,
}

#[async_trait]
impl PeerConnectionEventHandler for OfferHandler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.gathering_complete.try_send(());
        }
    }

    async fn on_connection_state_change(&self, _state: RTCPeerConnectionState) {}
}

/// Opens a P2P connection to the phone using `pairing_code` to find each other
/// via the signaling Worker at `signaling_base`, then bridges the resulting
/// DataChannel to `127.0.0.1:local_port` (the existing phone server). Runs
/// until the DataChannel closes or the initial handshake fails.
pub async fn run_offerer(pairing_code: String, signaling_base: String, local_port: u16) -> Result<(), String> {
    let mut media_engine = MediaEngine::default();
    media_engine.register_default_codecs().map_err(|e| e.to_string())?;
    let registry = register_default_interceptors(Registry::new(), &mut media_engine).map_err(|e| e.to_string())?;

    let config = RTCConfigurationBuilder::new()
        .with_ice_servers(vec![RTCIceServer { urls: vec![STUN_SERVER.to_string()], ..Default::default() }])
        .build();

    let (gathering_complete_tx, mut gathering_complete_rx) = mpsc::channel(1);
    let handler = Arc::new(OfferHandler { gathering_complete: gathering_complete_tx });
    let runtime = webrtc::runtime::default_runtime().ok_or("no webrtc runtime available")?;

    let peer_connection = PeerConnectionBuilder::new()
        .with_configuration(config)
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .with_handler(handler)
        .with_runtime(runtime)
        .with_udp_addrs(vec!["0.0.0.0:0".to_string()])
        .build()
        .await
        .map_err(|e| e.to_string())?;

    let data_channel = peer_connection.create_data_channel("bento", None).await.map_err(|e| e.to_string())?;
    tokio::spawn(bridge_data_channel_to_tcp(data_channel, local_port));

    let offer = peer_connection.create_offer(None).await.map_err(|e| e.to_string())?;
    peer_connection.set_local_description(offer).await.map_err(|e| e.to_string())?;
    // Best-effort: proceed with whatever candidates were gathered in time rather
    // than block forever on a straggling interface (see ICE_GATHERING_TIMEOUT).
    let _ = tokio::time::timeout(ICE_GATHERING_TIMEOUT, gathering_complete_rx.recv()).await;

    let local_description = peer_connection.local_description().await.ok_or("no local description after gathering")?;
    let client = reqwest::Client::new();
    post_json(&client, &format!("{signaling_base}/offer/{pairing_code}"), &local_description).await?;

    let answer: RTCSessionDescription = poll_until_available(&client, &format!("{signaling_base}/answer/{pairing_code}")).await?;
    peer_connection.set_remote_description(answer).await.map_err(|e| e.to_string())?;

    Ok(())
}

async fn post_json<T: serde::Serialize>(client: &reqwest::Client, url: &str, body: &T) -> Result<(), String> {
    let response = client.post(url).json(body).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("signaling POST {url} failed: {}", response.status()));
    }
    Ok(())
}

/// Polls `url` until it returns 200 (the peer has posted their side of the
/// handshake), or gives up after `SIGNALING_TIMEOUT`.
async fn poll_until_available<T: DeserializeOwned>(client: &reqwest::Client, url: &str) -> Result<T, String> {
    let deadline = tokio::time::Instant::now() + SIGNALING_TIMEOUT;
    loop {
        let response = client.get(url).send().await.map_err(|e| e.to_string())?;
        if response.status().is_success() {
            return response.json::<T>().await.map_err(|e| e.to_string());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!("timed out waiting for {url}"));
        }
        tokio::time::sleep(SIGNALING_POLL_INTERVAL).await;
    }
}

/// Pumps bytes between the DataChannel and a local TCP connection to the
/// existing phone server, once the channel opens. Never inspects the bytes —
/// the phone server on the other end of the TCP side already speaks the same
/// HTTP/WebSocket protocol it always has.
async fn bridge_data_channel_to_tcp(data_channel: Arc<dyn DataChannel>, local_port: u16) {
    let tcp_write: Arc<Mutex<Option<tokio::net::tcp::OwnedWriteHalf>>> = Arc::new(Mutex::new(None));

    while let Some(event) = data_channel.poll().await {
        match event {
            DataChannelEvent::OnOpen => start_tcp_bridge(&data_channel, local_port, &tcp_write).await,
            DataChannelEvent::OnMessage(msg) => forward_to_tcp(&tcp_write, &msg.data).await,
            DataChannelEvent::OnClose => return,
            _ => {}
        }
    }
}

async fn start_tcp_bridge(
    data_channel: &Arc<dyn DataChannel>,
    local_port: u16,
    tcp_write: &Arc<Mutex<Option<tokio::net::tcp::OwnedWriteHalf>>>,
) {
    let Ok(tcp) = TcpStream::connect(("127.0.0.1", local_port)).await else {
        let _ = data_channel.close().await;
        return;
    };
    let (mut read_half, write_half) = tcp.into_split();
    *tcp_write.lock().await = Some(write_half);

    let data_channel = data_channel.clone();
    tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        while let Ok(n) = read_half.read(&mut buf).await {
            if n == 0 {
                break;
            }
            if data_channel.send(BytesMut::from(&buf[..n])).await.is_err() {
                break;
            }
        }
        let _ = data_channel.close().await;
    });
}

async fn forward_to_tcp(tcp_write: &Arc<Mutex<Option<tokio::net::tcp::OwnedWriteHalf>>>, data: &BytesMut) {
    let mut guard = tcp_write.lock().await;
    let Some(write_half) = guard.as_mut() else { return };
    let _ = write_half.write_all(data).await;
}
