// Bootstrap page + client script served by this same Worker, reachable from
// anywhere (no Tailscale/LAN needed) — that's the whole point. Once paired,
// this page never talks to the Worker again: it pulls the real app
// (index.html, shared.js, terminal.js, review.js, ...) straight from the
// desktop over the DataChannel and injects it, unmodified.

export const PAIR_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Bento — Emparejar</title>
<style>
  body{font:16px -apple-system,system-ui,sans-serif;background:#111;color:#eee;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100dvh;margin:0;gap:16px;padding:24px;box-sizing:border-box;text-align:center}
  input{font:20px monospace;letter-spacing:4px;text-align:center;width:100%;max-width:220px;padding:12px;border-radius:8px;border:1px solid #444;background:#1a1a1a;color:#eee}
  button{font:16px -apple-system,system-ui,sans-serif;padding:12px 24px;border-radius:8px;border:none;background:#3b82f6;color:#fff;cursor:pointer}
  button:disabled{opacity:.5}
  #status{color:#999;font-size:14px;min-height:20px}
  #error{color:#f87171;font-size:14px;min-height:20px}
</style>
</head>
<body>
<div>Código de la app Bento</div>
<input id="code" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="off">
<button id="go">Conectar</button>
<div id="status"></div>
<div id="error"></div>
<script src="/pair.js"></script>
</body>
</html>
`

export const PAIR_JS = `(function () {
  const SIGNALING_BASE = location.origin
  const statusEl = document.getElementById('status')
  const errorEl = document.getElementById('error')
  const codeInput = document.getElementById('code')
  const goButton = document.getElementById('go')

  const params = new URLSearchParams(location.search)
  const codeFromUrl = params.get('code')
  if (codeFromUrl) codeInput.value = codeFromUrl
  // The real app reads its auth token from location.search (shared.js) — carried
  // here as our own query param, then written into the URL before injecting it.
  const authToken = params.get('token') || ''

  // loadRealApp() replaces document.body.innerHTML to inject the real app —
  // that detaches statusEl/errorEl from the document, so a status/error set
  // after that point would silently write to an invisible node. Re-check
  // .isConnected each call and fall back to a banner appended to <html>
  // (outside body, so it survives the swap) once that happens.
  let banner = null
  function ensureVisible(el) {
    if (el.isConnected) return el
    if (!banner) {
      banner = document.createElement('div')
      banner.id = 'pair-banner'
      banner.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:8px 12px;font:13px monospace;color:#fff;background:#1e3a5f;'
      document.documentElement.appendChild(banner)
    }
    return banner
  }
  function setStatus(text) { const el = ensureVisible(statusEl); el.textContent = text; if (el === banner) el.style.background = '#1e3a5f' }
  function setError(text) { const el = ensureVisible(errorEl); el.textContent = text; if (el === banner) el.style.background = '#7f1d1d' }

  // Real P2P networking doesn't always resolve — a stuck step should show an
  // error, not hang on "Cargando…" forever with nothing but devtools to tell
  // why.
  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(label + ': tardó más de ' + (ms / 1000) + 's')), ms)),
    ])
  }

  function tryConnect(code) {
    goButton.disabled = true
    setError('')
    connect(code).catch(err => {
      setError('No se pudo conectar: ' + (err && err.message || err))
      goButton.disabled = false
    })
  }

  goButton.addEventListener('click', () => {
    const code = codeInput.value.trim()
    if (!/^\\d{6}$/.test(code)) { setError('El código son 6 dígitos.'); return }
    tryConnect(code)
  })

  // A code from the URL (QR scan, or a reload/reopen carrying the code the
  // previous connect() left there — see history.replaceState below) means
  // this page doesn't need a human to tap "Conectar": the code is reusable
  // for a full day, so reconnect straight away.
  if (codeFromUrl && /^\\d{6}$/.test(codeFromUrl)) tryConnect(codeFromUrl)

  async function pollJson(url, signal) {
    while (true) {
      const res = await fetch(url, { signal })
      if (res.ok) return res.json()
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  // Best-effort, same as the desktop side: gathering across every local
  // interface can stall forever on one that never gets a STUN reply (seen
  // with a Tailscale interface present) — one usable candidate is enough,
  // so this doesn't wait past ICE_GATHERING_TIMEOUT_MS for the rest. 8s
  // (not 5s): the TURN relay candidate needs its own authenticated
  // ALLOCATE round-trip on top of the plain STUN binding request.
  const ICE_GATHERING_TIMEOUT_MS = 8000
  function waitForIceGatheringComplete(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ICE_GATHERING_TIMEOUT_MS)
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve() }
      })
    })
  }

  async function connect(code) {
    setStatus('Buscando la app…')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 120000)

    // Free public TURN relay (Open Relay Project) alongside STUN — direct P2P
    // can fail on some routers/NATs (no hairpinning for same-LAN STUN,
    // asymmetric NAT, Safari's mDNS-obfuscated host candidates) with nothing
    // to fall back to otherwise. Same static demo credential other
    // open-source projects use; see webrtc_bridge.rs for the Rust-side twin.
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      ],
    })
    pc.addEventListener('iceconnectionstatechange', () => setStatus('ICE: ' + pc.iceConnectionState))
    const dataChannelPromise = new Promise(resolve => {
      pc.addEventListener('datachannel', e => {
        e.channel.addEventListener('open', () => resolve(e.channel))
      })
    })

    // The signaling store (Cloudflare KV) is eventually consistent — a write
    // from the desktop side can take up to ~60s to become readable here, so
    // this first wait is the one most likely to look "stuck" while it's
    // actually just propagating.
    const slowSignalingHint = setTimeout(() => setStatus('Buscando la app… (puede tardar hasta 1 min la primera vez)'), 15000)
    const offer = await pollJson(SIGNALING_BASE + '/offer/' + code, controller.signal)
    clearTimeout(slowSignalingHint)
    await pc.setRemoteDescription(offer)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await waitForIceGatheringComplete(pc)

    setStatus('Conectando…')
    await fetch(SIGNALING_BASE + '/answer/' + code, {
      method: 'POST',
      body: JSON.stringify(pc.localDescription),
    })

    // Generous on purpose: by this point the offer/answer exchange has
    // already gone through KV twice (once each direction), each leg
    // possibly waiting out KV's own eventual-consistency window — a short
    // timeout here would fire before a perfectly healthy connection had a
    // real chance to finish.
    const channel = await withTimeout(dataChannelPromise, 90000, 'Apertura del canal P2P')
    setStatus('Conectado. Cargando la app…')
    installTransport(channel)
    // shared.js reads its auth token from location.search on load — put it there
    // before the real app's scripts run, so it authenticates like it always has.
    // Keep the code in the URL too (not just token): the code is reusable
    // for a full day now (see run_offerer's retry loop), and dropping it
    // here used to mean a reload had nothing left to reconnect with,
    // forcing a fresh QR scan even though the code itself was still valid.
    history.replaceState(null, '', location.pathname + '?code=' + code + '&token=' + encodeURIComponent(authToken))
    await withTimeout(loadRealApp(), 20000, 'Carga de la app')
    setStatus('Listo.')
  }

  function isSameOriginPath(url) {
    return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')
  }

  function base64ToArrayBuffer(b64) {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.buffer
  }

  function arrayBufferToBase64(buffer) {
    let binary = ''
    const bytes = new Uint8Array(buffer)
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary)
  }

  // Replaces fetch/WebSocket/EventSource with versions that speak the tunnel
  // protocol for same-origin paths (the desktop's own app), and fall back to
  // the real network for everything else (e.g. the xterm.js CDN scripts) —
  // terminal.js/review.js/shared.js never change, they just call these.
  function installTransport(channel) {
    const nativeFetch = window.fetch.bind(window)
    let nextId = 1
    const pendingHttp = new Map()
    const sockets = new Map()
    const sseSources = new Map()

    function send(envelope) { channel.send(JSON.stringify(envelope)) }

    channel.addEventListener('message', event => {
      // The Rust side sends binary DataChannel frames, so event.data is an
      // ArrayBuffer here, not a string — decode before parsing as JSON.
      let envelope
      try {
        const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
        envelope = JSON.parse(text)
      } catch (_) { return }
      switch (envelope.kind) {
        case 'http-response': {
          const pending = pendingHttp.get(envelope.id)
          if (pending) { pendingHttp.delete(envelope.id); pending(envelope) }
          break
        }
        case 'ws-open-ack': { const s = sockets.get(envelope.id); if (s) s._onOpen(); break }
        case 'ws-message': { const s = sockets.get(envelope.id); if (s) s._onMessage(envelope); break }
        case 'ws-close': { const s = sockets.get(envelope.id); if (s) s._onClose(); break }
        case 'ws-error': { const s = sockets.get(envelope.id); if (s) s._onError(); break }
        case 'sse-message': { const es = sseSources.get(envelope.id); if (es) es._onMessage(envelope.data); break }
        case 'sse-close': { const es = sseSources.get(envelope.id); if (es) es._onClose(); break }
        case 'sse-error': { const es = sseSources.get(envelope.id); if (es) es._onError(); break }
      }
    })

    window.fetch = function (url, opts) {
      const path = String(url)
      if (!isSameOriginPath(path)) return nativeFetch(url, opts)

      const id = String(nextId++)
      const headers = {}
      if (opts && opts.headers) for (const [k, v] of Object.entries(opts.headers)) headers[k] = v
      send({ kind: 'http', id, method: (opts && opts.method) || 'GET', path, headers, body: (opts && opts.body) || null })
      return new Promise(resolve => {
        pendingHttp.set(id, envelope => resolve(new Response(envelope.body == null ? '' : envelope.body, { status: envelope.status })))
      })
    }

    function BentoSocket(url) {
      this.id = String(nextId++)
      this.readyState = 0
      this.onopen = null
      this.onmessage = null
      this.onclose = null
      this.onerror = null
      sockets.set(this.id, this)
      send({ kind: 'ws-open', id: this.id, path: String(url).replace(/^wss?:\\/\\/[^/]+/, '') })
    }
    BentoSocket.prototype.send = function (data) {
      send({ kind: 'ws-message', id: this.id, data: String(data), isText: true })
    }
    BentoSocket.prototype.close = function () {
      send({ kind: 'ws-close', id: this.id })
      this._onClose()
    }
    BentoSocket.prototype._onOpen = function () { this.readyState = 1; if (this.onopen) this.onopen({}) }
    BentoSocket.prototype._onMessage = function (envelope) {
      const data = envelope.isText ? envelope.data : base64ToArrayBuffer(envelope.data)
      if (this.onmessage) this.onmessage({ data })
    }
    BentoSocket.prototype._onClose = function () {
      this.readyState = 3
      sockets.delete(this.id)
      if (this.onclose) this.onclose({})
    }
    BentoSocket.prototype._onError = function () { if (this.onerror) this.onerror({}) }
    window.WebSocket = BentoSocket

    function BentoEventSource(url) {
      this.id = String(nextId++)
      this.onmessage = null
      this.onerror = null
      sseSources.set(this.id, this)
      send({ kind: 'sse-open', id: this.id, path: String(url) })
    }
    BentoEventSource.prototype.close = function () { sseSources.delete(this.id) }
    BentoEventSource.prototype._onMessage = function (data) { if (this.onmessage) this.onmessage({ data }) }
    BentoEventSource.prototype._onClose = function () { sseSources.delete(this.id) }
    BentoEventSource.prototype._onError = function () {
      if (this.onerror) this.onerror({})
      sseSources.delete(this.id)
    }
    window.EventSource = BentoEventSource
  }

  // Pulls the real app from the desktop (through the now-tunneled fetch) and
  // replaces this pairing page with it — same HTML/CSS/JS bytes as loading it
  // directly over Tailscale/LAN, just fetched over the DataChannel instead.
  async function loadRealApp() {
    // shared.js/terminal.js/review.js add ?token=... to every request once
    // they're running (see history.replaceState above) — but this first
    // fetch happens before any of them have loaded, so it needs its own.
    const html = await (await fetch('/?token=' + encodeURIComponent(authToken))).text()
    const doc = new DOMParser().parseFromString(html, 'text/html')
    document.title = doc.title

    // This pairing page's own <style> (the pairing-form layout: centered,
    // padded body) would otherwise keep applying to the real app's markup
    // once it's injected below — e.g. its body align-items:center shrinks
    // and centers the real app's full-width tabbar instead of letting it
    // stretch. Drop it now that the real app's own stylesheets are about to
    // take over.
    for (const style of document.head.querySelectorAll('style')) style.remove()

    for (const link of doc.querySelectorAll('link[rel="stylesheet"]')) {
      const href = link.getAttribute('href')
      if (isSameOriginPath(href)) {
        const css = await (await fetch(href)).text()
        const style = document.createElement('style')
        style.textContent = css
        document.head.appendChild(style)
      } else {
        const tag = document.createElement('link')
        tag.rel = 'stylesheet'
        tag.href = href
        document.head.appendChild(tag)
      }
    }

    document.body.setAttribute('style', doc.body.getAttribute('style') || '')
    document.body.innerHTML = doc.body.innerHTML
    for (const inert of document.body.querySelectorAll('script')) inert.remove()

    for (const script of doc.querySelectorAll('script[src]')) {
      const src = script.getAttribute('src')
      if (isSameOriginPath(src)) {
        const code = await (await fetch(src)).text()
        const tag = document.createElement('script')
        tag.textContent = code
        document.body.appendChild(tag)
      } else {
        await new Promise((resolve, reject) => {
          const tag = document.createElement('script')
          tag.src = src
          tag.onload = resolve
          tag.onerror = reject
          document.body.appendChild(tag)
        })
      }
    }
  }
})()
`
