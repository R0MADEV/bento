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
- [x] **1.3** `wrangler deploy` → URL gratis en `*.workers.dev`. Dos caminos,
  documentados en `workers/signaling/README.md`:
  - **Botón "Deploy to Cloudflare"** (para quien no usa terminal — la
    audiencia real del proyecto, no solo devs): clic → login con Cloudflare
    → deploy, Cloudflare clona `workers/signaling/` a su propia cuenta de
    GitHub y aprovisiona todo solo. Requiere el repo público (lo es) y que
    el subdirectorio esté autocontenido (lo está: `package.json`/
    `wrangler.toml.example` propios, sin imports fuera de la carpeta).
  - **Terminal**, para quien lo prefiere:
    ```
    cd workers/signaling
    cp wrangler.toml.example wrangler.toml
    npx wrangler login
    npx wrangler deploy
    ```
  `wrangler.toml.example` **no trae `id` de KV namespace** — con wrangler
  ≥4.45 (auto-provisioning, confirmado con un deploy de prueba real:
  `wrangler` crea el namespace solo y lo bindea) no hace falta el paso
  manual `wrangler kv namespace create` + pegar el id que tenía este plan
  originalmente. `wrangler.toml` real sigue en `.gitignore` — una vez
  desplegado queda atado a la cuenta de quien lo corrió (casi se commitea
  así en esta misma sesión con el flujo viejo; se corrigió antes de llegar
  a un commit real).
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
- [x] **3.4** Reconexión con el mismo código: `run_offerer` (Rust) ahora es
  un loop acotado por `PAIRING_TTL` (24h, ver Seguridad) en vez de un solo
  ciclo oferta→respuesta. Cada vez que una ronda termina (el `DataChannel`
  se cierra, falla, o nadie contesta la oferta a tiempo) vuelve a publicar
  una oferta SDP **nueva** bajo el mismo código — así que si el móvil
  recarga la página, Safari descarga la pestaña en segundo plano, o se
  cierra y reabre la app, alcanza con volver a abrir la misma URL/QR: no
  hace falta generar un código nuevo desde la Mac. El lado del navegador no
  necesita lógica de reintento propia — un reload ya vuelve a correr
  `connect(code)` desde cero, que ahora encuentra una oferta fresca
  esperando. Antes de cada oferta nueva se borra (`DELETE`) la respuesta
  vieja en KV — si no, `poll_until_deadline` podía leer instantáneamente
  la respuesta de la ronda anterior, que no matchea el SDP nuevo (ufrag/pwd
  distintos) y rompe el handshake.

**Dos bugs reales más encontrados terminando 3.4** (el código de 24h no
servía de nada sin estos):
- `history.replaceState` después de conectar dejaba la URL en solo
  `?token=...`, **borrando el `code`**. Un reload entonces no tenía forma
  de saber qué código reintentar — pedía escanear el QR de nuevo pese a que
  el código seguía vivo 24h en el servidor. Fix: la URL ahora conserva
  `?code=...&token=...` los dos.
- Aunque el código quedara en la URL, no había nada que lo usara solo: un
  reload mostraba el formulario con el código prellenado pero exigía tocar
  "Conectar" a mano. Fix: si la URL trae un código válido al cargar, se
  llama a `connect()` automáticamente — un reload reconecta sin ningún
  toque.

**Bug de protocolo separado, encontrado investigando por qué no se veía lo
que se escribía en una terminal desde el móvil**: `Envelope` usa
`#[serde(rename_all = "kebab-case")]` a nivel de enum, que también afecta a
los NOMBRES DE CAMPO — convertía `is_text` en `"is-text"` en el JSON. Pero
el lado del navegador (`pairAssets.ts`) siempre leyó/escribió `isText`
(camelCase). Resultado: `envelope.isText` daba `undefined` (falsy) sin
importar el valor real, así que TODO mensaje de salida de terminal —
siempre texto plano, nunca binario — se trataba como si fuera base64 y se
mandaba a `atob()`, que fallaba con cada frame (confirmado con logging
temporal en ambos lados: Rust clasificando el frame como `text` siempre,
navegador tomando la rama de `base64ToArrayBuffer` siempre). Probablemente
rompía también la dirección contraria (pulsaciones de teclado), ya que
"is-text" faltante haría fallar el `deserialize` del lado Rust. Fix:
`#[serde(rename = "isText")]` puntual en ese campo, sin tocar el resto del
`rename_all`. Confirmado sin errores de `atob` tras el fix.

**Nota honesta sobre el timing de reconexión real**: el mecanismo en sí
está confirmado funcionando (el log de Rust muestra la oferta nueva
publicándose tras cada reload, sin intervención manual). Pero un reload
hereda la misma variabilidad de red real que la conexión inicial siempre
tuvo — en pruebas con Playwright, algunos reloads reconectaron al toque, otros
tardaron más de 2 minutos por la misma demora de propagación de KV ya
documentada. No es un bug nuevo del código de reconexión, es el mismo
trade-off del tier gratis de Cloudflare que ya se aceptó para la conexión
inicial — solo que ahora también aplica a los reloads.

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

- [x] **4.1** `PhonePanel.ts`: nueva sección "Emparejar sin Tailscale
  (WebRTC)" debajo del toggle de Tailscale existente — no lo reemplaza,
  conviven. Solo visible con el servidor WiFi activo (`s.running`). Campo
  para pegar la URL del Worker propio (persistido en localStorage,
  `bento.remote.webrtcSignalingBase`) y botón "Generar código".
- [x] **4.2** El botón genera un código de 6 dígitos client-side, llama al
  nuevo comando Tauri `webrtc_connect` (`src-tauri/src/pty.rs`, mismo patrón
  que `remote_start`/`remote_status`: forwarda `{cmd:"webrtc.connect", code,
  signaling_base}` al daemon por IPC) y arma la URL/QR
  `<worker>/pair?code=XXXXXX&token=YYYY` — el token sale del `remote_start`
  ya en curso, no hace falta pedirlo aparte.
- [x] **4.3** Indicador de estado real: conectando / P2P activo / falló /
  desconectado. `on_connection_state_change` (ya existía el hook en
  `webrtc_bridge.rs`, descartaba el estado) ahora manda un evento no
  solicitado `{event:"webrtc.status", code, state}` por el mismo canal IPC
  que usan `terminal.output`/`terminal.exit` — `ipc.rs` lo pasa a
  `run_offerer` como un `mpsc::UnboundedSender` extra. `src-tauri/src/
  pty.rs` lo reemite como evento Tauri `webrtc-status`; `PhonePanel.ts` lo
  escucha con `listen()` (mismo patrón que `TerminalPanel.ts`) y actualiza
  el texto de estado, filtrando por código para no mezclar un intento viejo
  con el que se está mostrando.
- [x] **4.4** `generatePairing()` ahora arranca `remote.start` sola si
  hace falta (reusa `startServer()`) en vez de solo avisar con un mensaje.
  La sección WebRTC dejó de estar gateada por `s.running` — siempre visible.

**Ajuste de protocolo IPC descubierto implementando esto**: `PtyManager::
request` (src-tauri) tiene un timeout fijo de 5s esperando la respuesta del
daemon — perfecto para `remote.start` (rápido, solo bindea un socket), pero
`webrtc.connect` puede tardar minutos reales (esperando a que una persona
escanee un QR). Si el handler de `ipc.rs` esperaba a que `run_offerer`
terminara del todo antes de responder, el comando Tauri fallaría con
"bento-daemon did not respond" casi siempre, aunque la conexión real
siguiera progresando bien en segundo plano. Fix: el handler de
`webrtc.connect` ahora responde `{started: true}` apenas arranca el intento
(no cuando termina) — `run_offerer` sigue corriendo en su propio
`tokio::spawn` sin que nadie espere el resultado final por este canal.

**Bug de layout encontrado probando desde un celular real** (nunca lo
hubiera visto con Playwright + viewport de escritorio, que fue todo lo que
se probó hasta este punto): la app real se veía angosta y centrada en vez
de ocupar todo el ancho de la pantalla. Causa: `loadRealApp()` nunca
quitaba el `<style>` propio de `PAIR_HTML` (el formulario de "Código de la
app Bento") al inyectar la app real — ese bloque define `body{align-items:
center; justify-content:center; padding:24px; ...}`, y como el body de la
app real también es un flex-container en columna, ese `align-items:center`
seguía aplicando y encogía/centraba sus hijos (el `#tabbar`, la lista de
terminales) en vez de dejarlos estirarse a todo el ancho. Fix: `loadRealApp
()` borra los `<style>` del `<head>` original antes de inyectar las hojas
de estilo de la app real. Confirmado con Playwright usando `devices['iPhone
13']` (nunca antes probado — todo el testing previo usaba viewport de
escritorio) + captura de pantalla real: antes, `#tabbar` medía 249px de 390
centrado; después, ancho completo.

**Timeout de apertura del DataChannel ampliado** (20s → 90s) por la misma
razón que la nota de KV más abajo: el intercambio de oferta/respuesta pasa
dos veces por KV (una por dirección), cada una pudiendo tardar hasta el
límite de propagación — 20s alcanzaba a cortar conexiones sanas antes de
que terminaran de establecerse.

**Bug de CSS encontrado y corregido verificando visualmente (captura de
pantalla real de la app corriendo)**: este proyecto no tiene una clase
`.hidden` genérica — cada componente define su propio combinador
`.algo.hidden { display:none }` (grep confirma 35+ reglas así, ninguna
genérica). Los elementos nuevos (`.phone-url-row`, `.phone-qr` cuando se
usan sueltos, no dentro de `.phone-active`) se quedaban visibles vacíos
hasta agregar sus propias reglas `.hidden`. De paso se corrigió el mismo bug
preexistente en `.phone-error` (visible como una barra vacía en el panel,
ajeno a este trabajo pero en el mismo archivo).

**Causa raíz encontrada de las conexiones intermitentes ("se queda en
Conectando…" / "Cargando la app…" sin avisar)**: no era un bug de ICE/WebRTC.
`GET /offer/:code` a veces devolvía 404 durante bastante más de un minuto
después de que el daemon confirmara `posting offer` sin error — y luego, sin
ningún cambio de código, empezaba a devolver 200. Es **consistencia eventual
de Cloudflare KV**: una escritura no es visible al instante desde cualquier
edge que la lea, puede tardar hasta ~60s (a veces más) en propagarse
globalmente — limitación conocida y documentada de KV en el plan gratuito
(Durable Objects, que sí son fuertemente consistentes, requieren el plan de
pago). El propio `connect()` del cliente ya tolera esto: `pollJson` reintenta
cada 1s dentro de un presupuesto total de 120s (`controller.abort()` a
120000ms), más que suficiente para el caso típico. Confirmado
reproduciendo en vivo: un código que devolvía 404 en el navegador durante los
55s de una prueba automatizada devolvía 200 minutos después, con el daemon
mostrando `remote description set` y luego `connection state -> connected`
apenas la respuesta llegó. **No requiere fix de código** — es un trade-off
inherente a usar el tier gratis de Cloudflare en vez de un VPS/TURN propio;
en el peor caso el primer emparejamiento tarda hasta un minuto.

**Bug real encontrado y corregido durante la misma investigación** (este sí
ocultaba errores): `loadRealApp()` reemplaza `document.body.innerHTML` para
inyectar la app real — pero `statusEl`/`errorEl` se habían capturado como
referencias al `<div id="status">`/`<div id="error">` originales al cargar
el script, así que quedaban **desconectados del DOM** justo antes del bucle
que carga los `<script>` de la app real. Cualquier `setStatus`/`setError`
posterior a ese punto (incluido el mensaje de `withTimeout` si algo tarda
más de 20s ahí) escribía en un nodo invisible — de ahí que pareciera
"colgado para siempre" sin ningún mensaje visible, incluso cuando sí había
un error real. Fix en `pairAssets.ts`: `setStatus`/`setError` ahora
comprueban `.isConnected` en cada llamada y, si el nodo original ya no está
en el documento, escriben en un banner fijo (`position:fixed`, añadido a
`<html>` en vez de `<body>`, así que sobrevive al reemplazo) — pequeño y sin
abstracción de más, solo asegura que el mensaje de estado siempre sea
visible sin importar en qué punto del flujo aparezca.

Se agregó también `iceconnectionstatechange` (navegador) y
`on_connection_state_change` (Rust, ya existía el hook pero descartaba el
estado) como logging — útil para diagnosticar sin necesitar reconstruir la
instrumentación de nuevo la próxima vez.

**Bug de layout descubierto probando desde un celular real** (nunca se
hubiera visto con Playwright + viewport de escritorio, que fue todo el
testing hasta ese punto): la app real se veía angosta y centrada en vez de
ocupar todo el ancho. Causa: `loadRealApp()` nunca quitaba el `<style>`
propio de `PAIR_HTML` (el formulario de "Código de la app Bento") al
inyectar la app real — ese bloque define `body { align-items: center;
justify-content: center; padding: 24px; ... }`, y como el body de la app
real también es un flex-container en columna, ese `align-items: center`
seguía aplicando y encogía/centraba sus hijos (`#tabbar`, la lista de
terminales) en vez de dejarlos estirarse a todo el ancho. Fix: `loadRealApp
()` borra los `<style>` del `<head>` original antes de inyectar las hojas
de estilo de la app real. Confirmado con Playwright usando
`devices['iPhone 13']` + captura de pantalla real: antes, `#tabbar` medía
249px de 390 centrado; después, ancho completo.

**"ICE: disconnected" / "ICE FAILED" reproducible solo con Safari real, no
con Playwright/Chromium** — root cause distinta de la de KV de arriba, esta
sí era un bug real de configuración:

1. **mDNS deshabilitado**: `PeerConnectionBuilder` (webrtc-rs) trae
   `mdns_mode: MulticastDnsMode::Disabled` por defecto — descarta cualquier
   candidato ICE remoto tipo `.local` (mDNS). Safari (y Chrome, confirmado
   con un test aislado) ofuscan sus candidatos "host" como
   `<uuid>.local` por privacidad — con mDNS deshabilitado esos candidatos
   se tiran directo a la basura, dejando solo la ruta `srflx` (vía STUN)
   disponible. Muchos routers domésticos no soportan "NAT hairpinning"
   (dos dispositivos de la misma LAN conectándose por su IP pública), así
   que esa ruta también podía fallar — combinación que explica los
   "funciona a veces, no otras" de antes. Fix: `SettingEngine::
   set_multicast_dns_mode(MulticastDnsMode::QueryOnly)` — resuelve
   candidatos mDNS remotos sin necesidad de anunciar los propios (no hace
   falta ocultar la IP LAN del Mac). `MulticastDnsMode` no está
   re-exportado por el crate `webrtc` pese a que `SettingEngine::
   set_multicast_dns_mode` sí lo necesita como parámetro — hubo que agregar
   `rtc = "0.20.3"` como dependencia directa (misma versión que usa
   `webrtc` internamente, para que Cargo las unifique) solo para acceder a
   `rtc::ice::mdns::MulticastDnsMode`.
2. **TURN de respaldo** (Open Relay Project / Metered.ca, gratis, mismo
   credential estático que usan otros proyectos open-source como Nextcloud
   Talk) agregado junto al STUN existente — mitiga el caso sin salida
   cuando ni mDNS ni STUN alcanzan. **Nota real**: un test aislado (Playwright
   + `RTCPeerConnection` directo, sin pasar por nuestro código) confirmó que
   la credencial estática `openrelayproject`/`openrelayproject` **no
   devuelve ningún candidato `relay`** ahora mismo — probablemente
   revocada/reemplazada por un esquema de API key en Metered.ca. Se dejó
   configurado igual (no hace daño, y podría volver a funcionar), pero **no
   es lo que arregló la conexión** — fue el fix de mDNS. Si se necesita TURN
   de verdad en el futuro, hace falta una cuenta propia (gratis) en
   Metered.ca u otro proveedor.
3. `ICE_GATHERING_TIMEOUT` subido de 5s a 8s en ambos lados: la solicitud
   TURN `ALLOCATE` (autenticada) tarda más que un simple STUN binding, 5s
   la cortaba antes de completarse.

---

## Seguridad

- El código de emparejamiento es reutilizable durante 24h (antes: un solo
  uso, 5 minutos) — `run_offerer` renegocia una oferta SDP nueva bajo el
  mismo código cada vez que hace falta (reload de la página, la pestaña se
  descarga en segundo plano, cerrar y reabrir la app), sin pedir un código
  nuevo cada vez. Trade-off explícito: quien vea el código/QR puede
  reconectarse durante esa ventana de 24h, no solo una vez — igual necesita
  estar en una red desde la que alcance al Mac, y el servidor real sigue
  gateado por su propio token (`remote.start`), independiente de esto.
- El tráfico real nunca pasa por Cloudflare — solo el handshake SDP/ICE.
- WebRTC cifra el DataChannel con DTLS-SRTP nativamente, sin configuración.
- El forwarder del Mac reenvía hacia la IP real que `remote.start` ya tiene
  bindeada (Tailscale o LAN, gateada por token) — no abre ninguna
  superficie nueva, solo un camino más para llegar a la que ya existe.
- TURN de respaldo (Open Relay Project, gratis) además del STUN — mitiga el
  caso "sin TURN, P2P directo falla, no hay nada más que intentar", aunque
  la credencial estática compartida no siempre está disponible (ver nota en
  Fase 3.4 más abajo).

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
