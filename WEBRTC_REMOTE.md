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
    │  1. Carga /pair desde el Worker (alcanzable sin Tailscale/LAN)
    │  2. Señalización: intercambia offer/answer vía el Worker
    ▼
Cloudflare Worker + KV  (gratis, sirve solo /pair, /pair.js, y el handshake)
    │
    │  3. Conexión P2P directa (WebRTC DataChannel, cifrada DTLS)
    ▼
Mac — Bento (Tauri)
    ├── daemon/bento-daemon
    │     ├── remote/mod.rs             (SIN CAMBIOS) — servidor HTTP+WS,
    │     │     bindeado a la IP real (Tailscale o LAN, gateado por token)
    │     └── remote/webrtc_bridge.rs   (NUEVO) — offerer WebRTC; traduce
    │           cada mensaje del DataChannel (protocolo de sobres JSON) a un
    │           request HTTP/WS real contra esa IP, vía reqwest/tungstenite
    └── Frontend TypeScript
          └── PhonePanel.ts (MODIFICADO) — nuevo modo "Emparejar sin Tailscale"
                con código corto / QR apuntando a /pair del Worker

Página de emparejamiento (workers/signaling/src/pairAssets.ts, servida por
el Worker): arma el RTCPeerConnection como answerer, y una vez abre el
DataChannel reemplaza fetch/WebSocket/EventSource EN LA MISMA PÁGINA (sin
Service Worker — no puede interceptar WebSocket) para hablar el protocolo de
sobres. Después trae index.html/shared.js/terminal.js/review.js reales del
Mac (fetch ya tuneleado) y los inyecta — esos archivos no cambian una línea.
```

**Nada de lo que ya funciona se toca.** El servidor Axum, sus rutas
(`/api/terminals`, `/ws/:id`, `/api/review/*`, etc.) y toda la web actual
siguen exactamente igual, sirviendo en `127.0.0.1:7879`. Lo único nuevo es
cómo el teléfono llega hasta ahí.

---

## Fases

### Fase 1 — Señalización (Cloudflare Worker + KV, gratis)

> Objetivo: que el móvil y el Mac se encuentren e intercambien SDP/ICE.

- [ ] **1.1** Cuenta gratuita de Cloudflare + `wrangler login` (una sola vez,
  la tiene que hacer el usuario — necesita su propia cuenta).
- [x] **1.2** Worker mínimo (`workers/signaling/src/worker.ts` +
  `src/pairing.ts`), sin framework:
  - `POST /offer/:code`  → guarda el offer SDP en KV bajo `code`, TTL 5 min
  - `GET  /offer/:code`  → lee el offer (el móvil hace polling ~1s)
  - `POST /answer/:code` → guarda el answer SDP
  - `GET  /answer/:code` → lee el answer (el Mac hace polling ~1s)
  - Código de emparejamiento: 6 dígitos aleatorios, expira solo, sin auth
    (el código en sí ya es el secreto — igual que un PIN de pairing)
  - **Simplificación tras empezar la Fase 2**: ICE es non-trickle
    (gather-then-send, como recomiendan los propios ejemplos oficiales de
    `webrtc-rs`) — se espera a que termine el gathering antes de mandar el
    SDP, que ya trae los candidatos embebidos. Por eso se sacó el endpoint
    `/ice/:code` que estaba en el diseño original: no hacía falta (YAGNI).
  - Verificado end-to-end en local con `wrangler dev --local` (KV simulada,
    sin cuenta de Cloudflare).
- [ ] **1.3** `wrangler deploy` → URL gratis en `*.workers.dev` (pendiente:
  requiere `wrangler kv namespace create PAIRING` con una cuenta real y
  pegar el id resultante en `wrangler.toml`)
- [x] **1.4** Tests (`tests/workers/signaling/pairing.test.ts`, TDD): formato
  del código, unicidad, keys de KV distintas por code

### Fase 2 — Forwarder en el daemon (Rust)

> Objetivo: el DataChannel WebRTC entra al Mac y llega a `127.0.0.1:7879`
> exactamente como si fuera una conexión de red normal.

- [x] **2.1** Dependencia `webrtc = "0.20.3"` (crate Rust, `webrtc-rs`) +
  `async-trait`, `bytes`, `reqwest` en `daemon/bento-daemon/Cargo.toml`.
  API real verificada contra el código fuente y los ejemplos oficiales del
  crate en GitHub (tag `v0.20.3`) en vez de asumida de memoria — la 0.20.x
  reescribió la API a builders (`PeerConnectionBuilder`,
  `RTCConfigurationBuilder`) + un `Runtime` inyectable, distinta de
  versiones más viejas.
- [x] **2.2** Nuevo `daemon/bento-daemon/src/remote/webrtc_bridge.rs`
  (nombrado así, no `webrtc.rs`, para no chocar con el propio crate
  `webrtc` en las rutas `use`):
  - Arma el `RTCPeerConnection` como *offerer*, crea el DataChannel,
    espera el gathering ICE (con timeout de 5s — ver nota abajo) y postea
    el offer al Worker; hace polling de `/answer/:code` hasta que el
    móvil conteste
  - Al abrir el DataChannel: por cada mensaje, reenvía crudo a un socket
    TCP local (`127.0.0.1:<port>`) y viceversa — proxy simple, sin parsear
    el contenido (no necesita saber qué es HTTP o WS, solo reenviar bytes)
  - **Bug real encontrado y corregido verificando en vivo** (no solo
    compilando): el gathering ICE se quedaba colgado para siempre en esta
    máquina — nunca disparaba `RTCIceGatheringState::Complete`. Diagnosticado
    activando logs internos del crate (`log`/`env_logger`, temporal, ya
    sacado): el STUN nunca vuelve por la interfaz de Tailscale
    (`100.88.x.x`), y el gatherer esperaba a que **todas** las interfaces
    locales terminaran antes de avisar. Fix: no bloquear indefinidamente en
    `gathering_complete_rx.recv()` — envolverlo en
    `tokio::time::timeout(ICE_GATHERING_TIMEOUT, ...)` y seguir con lo que
    se haya juntado (alcanza un candidato válido; ya se habían conseguido
    host + srflx en <1s por la interfaz LAN normal). Irónico: la interfaz
    de Tailscale — lo que este feature reemplaza — es la que rompía el
    reemplazo.
  - Verificado end-to-end real (no solo `cargo build`): Worker de
    señalización local (`wrangler dev`) + el binario del daemon compilado,
    hablándole por el socket IPC crudo (mismo protocolo que usa la app
    Tauri) con un código de pairing — el offer con SDP+candidatos válidos
    llega a KV en ~8s.
- [x] **2.3** Comando IPC nuevo `webrtc.connect` (`code`, `signaling_base`,
  `port` opcional) en `daemon/bento-daemon/src/ipc.rs`, mismo patrón que
  `remote.start` (spawn + responde ok/fail por el canal de salida).
- [x] **2.4** Tests: se verificó de punta a punta con un navegador real
  (Fase 3) en vez de con un mock — ver el resumen de la Fase 3 más abajo.

**Corrección importante encontrada al integrar con la Fase 3**: `local_port:
u16` fue reemplazado por `local_addr: String`. `remote.start` (el servidor
existente) bindea a una IP específica (Tailscale o LAN), **nunca** a
`127.0.0.1` ni a `0.0.0.0` — así que el forwarder no puede asumir loopback.
`webrtc.connect` ahora resuelve el target llamando a `remote.status()` (debe
estar corriendo primero) y usa su `addr` real.

### Fase 3 — Cliente WebRTC + envoltorio del lado móvil

> Objetivo: la web del móvil funciona igual sin saber que está sobre WebRTC.
> **Completa y verificada de punta a punta con un navegador real
> (Playwright/Chromium)**, no solo compilada.

**El diseño cambió respecto al original durante la implementación**, por dos
razones técnicas reales descubiertas al construirlo (no por preferencia):

1. Un Service Worker **no puede interceptar `WebSocket`** (solo `fetch`), y
   el terminal usa WebSocket crudo — así que la idea original de "SW
   transparente" no alcanza. Fix: en vez de un SW, la página de
   emparejamiento reemplaza `window.fetch`/`window.WebSocket`/
   `window.EventSource` directamente (misma página, sin *hand-off* a un
   worker) — sigue sin tocar `terminal.js`/`review.js`/`shared.js`.
2. El DataChannel de la Fase 2 llevaba **bytes crudos** (como un socket TCP),
   pero un navegador no puede correr `fetch`/`WebSocket` nativos sobre un
   transporte arbitrario sin reimplementar HTTP/WS a mano. Fix real
   (retroactivo a la Fase 2): se reemplazó por un protocolo de **sobres JSON**
   (`Envelope` en Rust) — `http`/`http-response`, `ws-open`/`ws-open-ack`/
   `ws-message`/`ws-close`/`ws-error`, `sse-open`/`sse-message`/`sse-close`/
   `sse-error`. El lado Rust usa `reqwest` (HTTP) y `tokio-tungstenite` (WS)
   reales contra el servidor existente — no reinventa el protocolo, solo lo
   traduce.

- [x] **3.1** Página de emparejamiento — pero servida por el **Worker de
  Cloudflare** (`workers/signaling/src/pairAssets.ts`, rutas `/pair` y
  `/pair.js` en `worker.ts`), no por Axum: tiene que ser alcanzable sin
  Tailscale/LAN desde el primer momento, que es justo el problema que
  resuelve todo esto. Pide el código, arma el `RTCPeerConnection` como
  *answerer* (ICE non-trickle, mismo timeout de 5s que el lado Rust — la
  interfaz de Tailscale de esta máquina se colgaba en el gathering del
  navegador exactamente igual que en Rust), hace el intercambio con el
  Worker.
- [x] **3.2** Sin Service Worker — la propia página parchea `fetch`/
  `WebSocket`/`EventSource` una vez abre el DataChannel, hablando el
  protocolo de sobres de la Fase 2. Solo tunelea paths mismo-origen
  (`/api/...`, `/ws/...`); URLs absolutas (el CDN de xterm.js) se dejan
  pasar por la red real del teléfono sin tocar.
- [x] **3.3** El HTML/JS reales (`index.html`, `shared.js`, `terminal.js`,
  `review.js`, CSS) se piden con el `fetch` ya parcheado y se inyectan en el
  DOM de la página de emparejamiento — no hay navegación real (eso sí
  requeriría Service Worker). Cero cambios en esos archivos.
- [ ] **3.4** Reconexión: si el DataChannel se cae, mostrar "reconectando"
  y reintentar el emparejamiento con el mismo código si sigue vivo en KV —
  pendiente, no cubierto todavía.

**Verificado de punta a punta con Chromium real (Playwright), no solo con
`cargo build`/`tsc`**: `wrangler dev --local` (Worker) + el binario del
daemon + `remote.start` real + `webrtc.connect` real, todo hablado por los
mismos protocolos IPC/HTTP/WS que usa la app de verdad. Resultado: la app
completa se carga a través del túnel P2P (HTML de 12KB inyectado, CSS/JS
cargados), la lista de terminales devuelve datos reales vía `fetch`
tuneleado, y **abrir una terminal real funciona** — xterm.js renderiza salida
de PTY real a través del WebSocket tuneleado (58KB de contenido en pantalla,
indicador de conexión en verde). Bugs reales encontrados y corregidos en el
camino (no hipotéticos):
- El sobre JSON se mandaba como frame **binario** del DataChannel; el
  navegador entrega frames binarios como `ArrayBuffer`, no `string` — el
  `JSON.parse` fallaba en silencio. Fix: decodificar con `TextDecoder` antes
  de parsear.
- `GET /` (el HTML) está gateado por token igual que `/api/*` — el primer
  `fetch` de la página de emparejamiento no tenía token todavía (se agrega
  recién cuando `shared.js` corre). Fix: pasar `?token=` también en ese
  primer fetch.
- El bug de bind-address de la Fase 2 (arriba) — sin este fix, absolutamente
  nada llega al servidor real.

### Fase 4 — UI en Bento (desktop)

- [ ] **4.1** `PhonePanel.ts`: nueva opción "Conectar sin Tailscale" junto
  al toggle de Tailscale existente (no lo reemplaza, conviven)
- [ ] **4.2** Genera el código de 6 dígitos + QR que apunta a
  `https://<worker>.workers.dev/pair?code=XXXXXX&token=YYYY` (el token viaja
  en la URL porque la página de emparejamiento lo necesita antes de que
  `shared.js` exista para leerlo de otra forma)
- [ ] **4.3** Indicador de estado: conectando / P2P activo / falló (sugiere
  volver a Tailscale/LAN)
- [ ] **4.4** Llamar `remote.start` automáticamente si no está corriendo
  antes de `webrtc.connect` (hoy hace falta invocarlo a mano primero)

---

## Seguridad

- El código de emparejamiento es de un solo uso y expira a los 5 minutos —
  quien no lo tenga no puede unirse a la señalización.
- El tráfico real nunca pasa por Cloudflare — solo el handshake SDP/ICE.
- WebRTC cifra el DataChannel con DTLS-SRTP nativamente, sin configuración.
- El forwarder del Mac reenvía hacia la IP real que `remote.start` ya tiene
  bindeada (Tailscale o LAN, gateada por token) — no abre ninguna
  superficie nueva, solo un camino más para llegar a la que ya existe.
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
