# Control remoto sin Tailscale (WebRTC)

Reemplaza la dependencia de Tailscale por una conexión **P2P directa vía WebRTC**
entre el móvil y el Mac. El tráfico real (terminales, agentes, tareas) sigue
yendo directo entre los dos dispositivos, cifrado por WebRTC — nada pasa por
un tercero salvo el intercambio inicial de señalización.

Ver [PHONE_REMOTE.md](./PHONE_REMOTE.md) para la Fase 1-4 ya implementada
(servidor LAN/Tailscale actual). Este documento cubre solo el reemplazo del
transporte de red — **cero cambios** en la lógica de terminales, agentes,
review o tareas del daemon.

---

## Por qué

- Tailscale exige instalar una app en el móvil y tener cuenta.
- WebRTC no necesita nada instalado: el navegador del móvil ya lo soporta.
- El único costo es un punto de encuentro público para el "apretón de manos"
  inicial (SDP/ICE) — no para el tráfico. Se resuelve gratis con Cloudflare
  Workers + KV (ver más abajo), sin VPS ni costo mensual.

## Por qué NO reemplaza Tailscale del todo (limitación conocida)

WebRTC negocia P2P directo vía STUN (público y gratis: `stun.l.google.com`).
Eso alcanza en la mayoría de redes. Pero en NATs simétricos o WiFis
corporativas restrictivas, STUN no basta y hace falta un servidor **TURN**
(relay del tráfico real) — y eso sí tiene costo si se quiere confiable
(Cloudflare Calls TURN es de pago; TURN "gratis" público no es confiable para
uso real). **Decisión: por ahora, sin TURN.** Si falla el P2P directo, el
móvil muestra "no se pudo conectar" y el usuario puede volver al modo
Tailscale/LAN existente, que sigue disponible sin tocar.

---

## Arquitectura

```
Tu móvil (navegador, sin app)
    │
    │  1. Señalización (una vez, al conectar)
    ▼
Cloudflare Worker + KV  (gratis, sirve solo para el handshake)
    │
    │  2. Conexión P2P directa (WebRTC DataChannel, cifrada DTLS)
    ▼
Mac — Bento (Tauri)
    ├── daemon/bento-daemon
    │     ├── remote/mod.rs        (SIN CAMBIOS) — servidor HTTP+WS en 127.0.0.1:7879
    │     └── remote/webrtc.rs     (NUEVO) — acepta el DataChannel, hace de
    │           forwarder crudo hacia 127.0.0.1:7879 (localhost únicamente)
    └── Frontend TypeScript
          └── PhonePanel.ts (MODIFICADO) — nuevo modo "Emparejar sin Tailscale"
                con código corto / QR apuntando al Worker de señalización

Web del móvil (daemon/bento-daemon/src/remote/web/*.html, SIN CAMBIOS en su
lógica de terminales/agentes/tareas) + Service Worker (NUEVO, mismo bundle)
que intercepta fetch()/WebSocket() de la página y los tuneliza por el
DataChannel en vez de por la red real.
```

**Nada de lo que ya funciona se toca.** El servidor Axum, sus rutas
(`/api/terminals`, `/ws/:id`, `/api/review/*`, etc.) y toda la web actual
siguen exactamente igual, sirviendo en `127.0.0.1:7879`. Lo único nuevo es
cómo el teléfono llega hasta ahí.

---

## Fases

### Fase 1 — Señalización (Cloudflare Worker + KV, gratis)

> Objetivo: que el móvil y el Mac se encuentren e intercambien SDP/ICE.

- [ ] **1.1** Cuenta gratuita de Cloudflare + `wrangler login` (una sola vez).
- [ ] **1.2** Worker mínimo (`workers/signaling/index.ts`), sin framework:
  - `POST /offer/:code`  → guarda el offer SDP en KV bajo `code`, TTL 5 min
  - `GET  /offer/:code`  → lee el offer (el móvil hace polling ~1s)
  - `POST /answer/:code` → guarda el answer SDP
  - `GET  /answer/:code` → lee el answer (el Mac hace polling ~1s)
  - `POST /ice/:code`    → agrega un ICE candidate a una lista en KV
  - `GET  /ice/:code`    → lee los ICE candidates nuevos
  - Código de emparejamiento: 6 dígitos aleatorios, expira solo, sin auth
    (el código en sí ya es el secreto — igual que un PIN de pairing)
- [ ] **1.3** `wrangler deploy` → URL gratis en `*.workers.dev`
- [ ] **1.4** Tests: expiración del código, formato inválido rechazado

### Fase 2 — Forwarder en el daemon (Rust)

> Objetivo: el DataChannel WebRTC entra al Mac y llega a `127.0.0.1:7879`
> exactamente como si fuera una conexión de red normal.

- [ ] **2.1** Dependencia `webrtc` (crate Rust, `webrtc-rs`) en
  `daemon/bento-daemon/Cargo.toml`.
- [ ] **2.2** Nuevo `daemon/bento-daemon/src/remote/webrtc.rs`:
  - Arma el `RTCPeerConnection`, hace polling al Worker (Fase 1) con el
    código que le pasa el usuario, intercambia offer/answer/ICE
  - Al abrir el DataChannel: por cada mensaje, reenvía crudo a un socket
    TCP local (`127.0.0.1:7879`) y viceversa — proxy simple, sin parsear
    el contenido (no necesita saber qué es HTTP o WS, solo reenviar bytes)
- [ ] **2.3** Comando IPC nuevo para que la app Tauri le pida al daemon
  "empezar a escuchar un código de emparejamiento X"
- [ ] **2.4** Tests: el forwarder reenvía bytes en ambas direcciones sin
  corromper el framing (test con un servidor TCP de prueba en vez de axum)

### Fase 3 — Cliente WebRTC + Service Worker (móvil)

> Objetivo: la web del móvil funciona igual sin saber que está sobre WebRTC.

- [ ] **3.1** Página de emparejamiento nueva (`/pair`, servida por el mismo
  Axum de siempre): pide el código de 6 dígitos, arma el `RTCPeerConnection`
  del lado móvil, hace el mismo intercambio con el Worker
- [ ] **3.2** Service Worker (`sw.js`, nuevo): una vez conectado el
  DataChannel, se registra y **intercepta todo `fetch`/`WebSocket` del mismo
  origen**, lo serializa (método, path, headers, body) y lo manda por el
  DataChannel; el forwarder del Mac (Fase 2) ya lo entrega a Axum como una
  conexión más
- [ ] **3.3** El resto del HTML/JS de terminales/agentes/tareas **no cambia
  una línea** — corre contra `fetch`/`WebSocket` normales, ajenos a que
  ahora viajan por el Service Worker
- [ ] **3.4** Reconexión: si el DataChannel se cae, mostrar "reconectando"
  y reintentar el emparejamiento con el mismo código si sigue vivo en KV

### Fase 4 — UI en Bento (desktop)

- [ ] **4.1** `PhonePanel.ts`: nueva opción "Conectar sin Tailscale" junto
  al toggle de Tailscale existente (no lo reemplaza, conviven)
- [ ] **4.2** Genera el código de 6 dígitos + QR que apunta a
  `https://<mismo-origen>/pair?code=XXXXXX`
- [ ] **4.3** Indicador de estado: conectando / P2P activo / falló (sugiere
  volver a Tailscale/LAN)

---

## Seguridad

- El código de emparejamiento es de un solo uso y expira a los 5 minutos —
  quien no lo tenga no puede unirse a la señalización.
- El tráfico real nunca pasa por Cloudflare — solo el handshake SDP/ICE.
- WebRTC cifra el DataChannel con DTLS-SRTP nativamente, sin configuración.
- El forwarder del Mac solo escucha localhost (`127.0.0.1:7879`) — igual
  que hoy, el server Axum nunca se expone directo a la red.
- Sin TURN: si el P2P directo falla, no hay relay de respaldo — se informa
  al usuario en vez de degradar silenciosamente a algo menos seguro.

---

## Decisiones pendientes

- [ ] ¿El Worker de señalización va en un repo aparte o dentro de
  `bento/workers/signaling/`? (sugerido: dentro, mismo repo, un solo
  `wrangler.toml`)
- [ ] ¿Se deja Tailscale como fallback permanente, o se lo saca una vez que
  WebRTC esté probado en el uso real?
- [ ] TURN de pago (Cloudflare Calls) si en la práctica el P2P directo falla
  seguido — evaluar después de medir, no de entrada.

---

## Orden de implementación sugerido

```
Fase 1 (Worker señalización)  →  Fase 2 (forwarder Rust)
    →  Fase 3 (cliente + Service Worker móvil)  →  Fase 4 (UI Bento)
```

Cada fase es verificable por separado: la Fase 1 se prueba con `curl`, la
Fase 2 con un cliente WebRTC de prueba en Node, la Fase 3 ya da una demo
punta a punta, la Fase 4 es solo pulido de UX.
