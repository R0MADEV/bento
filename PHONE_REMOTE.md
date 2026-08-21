# Control remoto desde el móvil

Controla terminales y agentes de Bento desde tu teléfono (o cualquier navegador),
sin instalar app y sin servidor externo. El Mac con Bento abierto **es** el servidor.

---

## Arquitectura

```
Tu móvil (navegador)
    │
    │  WiFi local  (Fase 1)
    │  Tailscale   (Fase 4)
    ▼
Mac — Bento (Tauri)
    ├── Backend Rust
    │     ├── remote.rs  (NUEVO) — servidor HTTP + WebSocket
    │     │     ├── GET  /                → sirve la web del móvil
    │     │     ├── GET  /api/terminals   → lista de terminales/agentes abiertos
    │     │     └── WS   /ws/:id         → puente bidireccional con el PTY
    │     ├── pty.rs  (MODIFICADO) — broadcast de salida a múltiples consumidores
    │     └── main.rs (MODIFICADO) — arranque/parada del servidor remoto
    └── Frontend TypeScript
          ├── Ajustes: toggle on/off + puerto + QR
          └── Indicador de estado en la barra
```

---

## Fases

### Fase 1 — Servidor LAN + auth (MVP)
> Objetivo: ver un terminal en el móvil desde la misma WiFi.

- [ ] **1.1** Añadir dependencias Rust a `Cargo.toml`:
  - `axum` — servidor HTTP/WebSocket
  - `tokio-tungstenite` — WebSocket
  - `local-ip-address` — detectar IP de la red local
  - `qrcode` — generar QR

- [ ] **1.2** Crear `src-tauri/src/remote.rs`:
  - Generar token aleatorio en el primer arranque (guardado en `app_data_dir`)
  - Servidor HTTP en puerto configurable (default `7878`)
  - Middleware de auth: todas las rutas comprueban `?token=<token>` o header `X-Token`
  - `GET  /`               → sirve la web del móvil (HTML embebido en el binario)
  - `GET  /api/terminals`  → JSON con la lista de PTYs abiertos (id, título, cwd, tipo)
  - `WS   /ws/:id`         → bridge: output PTY → WS, input WS → PTY

- [ ] **1.3** Modificar `src-tauri/src/pty.rs`:
  - Añadir `tokio::sync::broadcast::Sender<String>` por instancia de PTY
  - El hilo de lectura del PTY emite a **dos** destinos: Tauri window (como hasta ahora) + broadcast (para el WS)
  - Exponer el sender en `PtyInstance` para que `remote.rs` pueda suscribirse

- [ ] **1.4** Modificar `src-tauri/src/main.rs`:
  - Arrancar el servidor al iniciar la app si `remote.enabled = true` en settings
  - Comandos Tauri: `remote_start`, `remote_stop`, `remote_status`

- [ ] **1.5** Tests:
  - Token se genera y persiste entre reinicios
  - Petición sin token devuelve 401
  - Lista de terminales devuelve el array correcto

---

### Fase 2 — Frontend: toggle + QR
> Objetivo: activar/desactivar el servidor desde Bento y escanear el QR.

- [ ] **2.1** Nuevo panel o sección en Settings:
  - Toggle "Control desde el móvil" (on/off)
  - Campo de puerto (default 7878)
  - Cuando está activo: muestra IP + URL completa + QR
  - Botón "Copiar URL"
  - Botón "Regenerar token" (invalida sesiones abiertas)

- [ ] **2.2** QR: generado en Rust (crate `qrcode`) → PNG → base64 → `<img>` en el frontend

- [ ] **2.3** Indicador en la barra de Bento:
  - Icono de móvil/WiFi cuando el servidor está activo
  - Tooltip con la URL

---

### Fase 3 — Web del móvil
> Objetivo: interfaz completa en el navegador del móvil.

- [ ] **3.1** HTML/CSS/JS embebido en el binario de Bento (`include_str!` o paso de build):
  - Sin dependencias externas en runtime (todo inline o bundleado)

- [ ] **3.2** Vista de lista de terminales/agentes:
  - Nombre, tipo (terminal / claude / opencode…), cwd, estado (working/idle)
  - Toca un agente → abre su terminal

- [ ] **3.3** Vista de terminal:
  - `xterm.js` para renderizar la salida del PTY por WebSocket
  - Input en la parte inferior, adaptado para teclado móvil
  - Botones rápidos: Enter, Ctrl+C, Tab, flechas
  - Scroll táctil

- [ ] **3.4** Reconexión automática si se pierde la conexión WebSocket

---

### Fase 4 — Remoto (Tailscale) + pulido
> Objetivo: conectar desde cualquier red, no solo la WiFi de casa.

- [ ] **4.1** Detectar la IP de Tailscale (`100.x.x.x`) si está instalado
- [ ] **4.2** Opción en settings: "Escuchar en Tailscale" (en vez de la IP local)
- [ ] **4.3** Modo solo lectura: el móvil puede ver pero no escribir
- [ ] **4.4** Múltiples clientes simultáneos en el mismo terminal
- [ ] **4.5** Envío de entrada a agentes (Claude, OpenCode…) sin solo terminal crudo

---

## Seguridad

- **Apagado por defecto.** El usuario lo activa explícitamente.
- **Token obligatorio.** Sin él, todas las rutas devuelven 401.
- **Solo LAN por defecto.** El servidor escucha en la IP local, no en `0.0.0.0`.
- **Tailscale para remoto.** Nunca exponer el puerto directamente a internet.
- **Token regenerable.** Un botón en settings invalida el token anterior.
- **Sin persistencia de sesiones.** Cada conexión WS necesita el token.

---

## Decisiones pendientes

- [ ] ¿Puerto fijo (7878) o configurable desde el primer día?
- [ ] ¿La web del móvil se bundlea en el binario o se sirve como archivos estáticos?
- [ ] ¿Modo read-only desde la Fase 1 o se añade en la Fase 4?

---

## Orden de implementación sugerido

```
Fase 1 (MVP LAN)  →  Fase 2 (QR/toggle)  →  Fase 3 (web móvil)  →  Fase 4 (Tailscale)
```

Cada fase es funcional por sí sola. Al terminar la Fase 2 ya puedes ver terminales
en el móvil (aunque la UI sea básica). La Fase 3 añade la experiencia completa.
