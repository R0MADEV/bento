# Bento — Roadmap v2 (lo que falta)

Continuación de [`DAEMON.md`](DAEMON.md) y [`PHONE_REMOTE.md`](PHONE_REMOTE.md).
Este documento cubre **solo lo pendiente**: la base (daemon + servidor móvil) ya
funciona y está confirmada en dispositivo real.

---

## ✅ Ya funciona (base terminada)

| Pieza | Estado | Dónde |
|---|---|---|
| `bento-core` — PTY manager sin Tauri (open idempotente, scrollback, broadcast) | ✅ | `daemon/bento-core/src/pty.rs` |
| `bento-daemon` — IPC TCP `127.0.0.1:7877`, line-JSON | ✅ | `daemon/bento-daemon/src/ipc.rs` |
| `bento` CLI — `daemon status`, `terminals`, `open`, `attach` | ✅ | `daemon/bento-cli/src/main.rs` |
| App Tauri delega en el daemon (auto-arranca, reattach al recargar) | ✅ | `src-tauri/src/pty.rs` |
| **Servidor móvil** — HTTP + WebSocket token-gated, xterm en el navegador | ✅ | `daemon/bento-daemon/src/remote.rs` |

**Confirmado en móvil:** listar terminales, abrir uno, ver la salida en vivo y
ejecutar `claude` desde el teléfono por WiFi local.

**Pega actual:** montarlo requiere baile manual — matar daemons, exportar
`BENTO_REMOTE_ADDR` / `BENTO_REMOTE_TOKEN`, averiguar la IP y teclear la URL.
La v2 elimina ese baile.

---

## Fase A — Toggle + QR en Bento *(prioridad máxima)*
> Objetivo: activar el control remoto desde un botón en la app. Sin terminal, sin env vars.

- [ ] **A.1** Comando IPC nuevo en el daemon: `remote.start` / `remote.stop` / `remote.status`
  - `remote.start { addr?, token? }` → arranca `remote::serve` en caliente (hoy solo
    arranca al lanzar el proceso si existe `BENTO_REMOTE_ADDR`). Devuelve `{ addr, token }`.
  - Guardar el `JoinHandle` del `tokio::spawn` para poder pararlo.
  - `remote.status` → `{ running: bool, addr, token, url }`.
  - Ficheros: `daemon/bento-daemon/src/remote.rs` (exponer start/stop), `ipc.rs` (dispatch),
    `main.rs` (dejar de leer el env directamente y delegar en el comando).

- [ ] **A.2** Detectar la IP LAN real en Rust:
  - Crate `local-ip-address` → construir `http://<ip>:<port>/?token=<token>`.
  - Fallback a `127.0.0.1` si no hay red.

- [ ] **A.3** Generar el QR **en Rust**:
  - Crate `qrcode` → PNG → base64 → se manda al frontend como data-URL.
  - Evita depender de un CDN en el móvil para el propio QR.

- [ ] **A.4** Cliente daemon en la app (TS/Rust puente): `remote_start`, `remote_stop`,
  `remote_status` como comandos Tauri que reenvían al IPC del daemon.
  - Fichero: `src-tauri/src/pty.rs` (ya tiene `request()`; añadir estos comandos).

- [ ] **A.5** UI de ajustes — sección "Control desde el móvil":
  - Toggle on/off.
  - Al activar: muestra **URL + QR + botón copiar**.
  - Botón "Regenerar token" (invalida el anterior).
  - Aviso de seguridad: "solo en tu red WiFi".
  - Dónde encaja: seguir el patrón de panel existente (ver `src/panels/*`). Sin panel
    nuevo si cabe en la config lateral de un panel ya existente.

- [ ] **A.6** Persistir preferencia (activado/puerto) para reactivar al reabrir.

**Resultado:** activar toggle → escanear QR → listo.

---

## Fase B — UX del móvil
> Objetivo: que un TUI (Claude/OpenCode) se use cómodo con el pulgar.

- [ ] **B.1** Barra de teclas rápidas: `Esc`, `Tab`, `Ctrl+C`, `↑ ↓ ← →`, `Enter`.
  - Hoy solo hay input + `^C`. Un TUI necesita flechas y `Esc`.
- [ ] **B.2** Reconexión automática del WebSocket con backoff (hoy solo escribe
  `[desconectado]` y muere).
- [ ] **B.3** `xterm-addon-fit` para ajustar filas/columnas al tamaño del móvil y
  mandar `resize` al PTY (hoy el tamaño es fijo → los TUI se pintan mal).
- [ ] **B.4** Scroll táctil fluido + botón "ir al final".
- [ ] **B.5** Bundlear `xterm` en el binario (`include_str!`) en vez del CDN de unpkg
  → funciona sin internet en el móvil.
  - Fichero: `daemon/bento-daemon/src/remote.rs` (`MOBILE_HTML`).

Fichero central de esta fase: `MOBILE_HTML` en `remote.rs`.

---

## Fase C — Auto-arranque del daemon *(Fase 3 de `DAEMON.md`)*
> Objetivo: el daemon vive aunque no abras la app ni el CLI.

- [ ] **C.1** `bento daemon install` — registra auto-arranque por SO:
  - macOS: `~/Library/LaunchAgents/dev.bento.daemon.plist`
  - Linux: `~/.config/systemd/user/bento-daemon.service` + `systemctl --user enable`
  - Windows: `HKCU\...\Run`
- [ ] **C.2** `bento daemon uninstall` — revierte lo anterior.
- [ ] **C.3** `bento daemon start` en background real (hoy la app lo auto-lanza; falta
  el arranque explícito desde el CLI cuando la app no corre).

---

## Fase D — Comandos de agentes en el CLI
> Objetivo: lanzar/listar agentes desde `bento`, no solo terminales crudos.

- [ ] **D.1** `bento agent run claude --cwd <path> --message "..."`
- [ ] **D.2** `bento agent list`
- [ ] **D.3** `bento agent attach <id>`
- [ ] Reusar la lógica de `src-tauri/src/agent/mod.rs` movida/compartida vía `bento-core`.

---

## Fase E — Remoto fuera de casa (Tailscale)
> Objetivo: conectar desde datos móviles, no solo la WiFi local.

- [ ] **E.1** Detectar IP de Tailscale (`100.x.x.x`) si está instalado.
- [ ] **E.2** Opción en ajustes: "Escuchar en Tailscale" en vez de la IP LAN.
- [ ] **E.3** Nunca exponer el puerto directo a internet — Tailscale es el único camino remoto soportado.

---

## Fase F — Multi-cliente y read-only
- [ ] **F.1** Modo solo-lectura (el móvil ve pero no escribe) — toggle por sesión.
- [ ] **F.2** Varios clientes en el mismo terminal a la vez (el `broadcast` ya lo permite;
  falta probar y pulir la sincronización de tamaño).

---

## 🐞 Bug pendiente (independiente del daemon)

- [ ] **Scroll en OpenCode** — en el panel de terminal, con OpenCode abierto, el scroll
  arriba/abajo no responde ("nunca puedo scrollear"). Reproducir y aislar si es del
  modo alt-screen de OpenCode vs. el manejo de rueda de xterm en `TerminalPanel.ts`.

---

## Orden sugerido

```
A (toggle+QR)  →  B (UX móvil)  →  C (auto-arranque)  →  D (agentes CLI)  →  E (Tailscale)  →  F (multi/RO)
```

La **Fase A** es la que convierte esto en algo usable a diario: sin ella, cada uso
es una sesión de terminal manual. Las demás son mejoras incrementales, cada una
funcional por sí sola.

---

## Seguridad (se mantiene de v1)

- Apagado por defecto — el usuario lo activa.
- Token obligatorio — sin él, 401 en todas las rutas.
- Solo LAN por defecto — Tailscale para remoto, nunca `0.0.0.0` hacia internet.
- Token regenerable — invalida sesiones abiertas.
