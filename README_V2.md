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

## ✅ Fase A — Toggle + QR en Bento
> Completada. Toggle on/off, URL+QR, token persistido, auto-start al abrir panel, lifecycle daemon.

- [x] **A.1** `remote.start` / `remote.stop` / `remote.status` en daemon IPC
- [x] **A.2** IP LAN real detectada en Rust (UDP trick, sin crate extra)
- [x] **A.3** QR generado en el frontend (qrcode.js inline en `PhonePanel.ts`)
- [x] **A.4** `remote_start`, `remote_stop`, `remote_status` como comandos Tauri en `pty.rs`
- [x] **A.5** Panel "Control Móvil" (`src/panels/remote/PhonePanel.ts`) — toggle + URL + QR
- [x] **A.6** Token persistido en localStorage; estado `sessionStopped` para no re-activar si el usuario lo paró

---

## ✅ Fase B — UX del móvil
> Completada. TUI usable desde el móvil con flechas, reconexión y resize.

- [x] **B.1** Barra de teclas rápidas: `Esc`, `Tab`, `↑↓←→`, `^C`, `^D`, `^L`, `Home`, `End`
- [x] **B.2** Reconexión automática del WebSocket con backoff exponencial (hasta 16 s)
- [x] **B.3** `xterm-addon-fit` — resize al cambiar orientación/ventana, manda `{type:"resize"}` al PTY
- [x] **B.4** Scroll táctil vía `touch-action:pan-y` en la lista; terminal a pantalla completa
- [x] **B.5** xterm bundleado en el binario (`MOBILE_HTML` en `remote.rs` — sin CDN)

---

## ✅ Fase C — Auto-arranque del daemon
> Completada. El daemon puede vivir sin la app abierta.

- [x] **C.1** `bento daemon install` — registra auto-arranque:
  - macOS: `~/Library/LaunchAgents/dev.bento.daemon.plist` + `launchctl load -w`
  - Linux: `~/.config/systemd/user/bento-daemon.service` + `systemctl --user enable --now`
- [x] **C.2** `bento daemon uninstall` — revierte (unload/disable + rm plist/service)
- [x] **C.3** `bento daemon start` — arranca el daemon en background desde el CLI (sin la app)

---

## ~~Fase D — Comandos de agentes en el CLI~~ *(descartada)*
> Solo tiene sentido si el daemon vive independiente de la app (con `daemon install`).
> El caso de uso real es activar el control móvil desde Bento (desktop o CLI), no lanzar agentes desde el CLI.
> Implementada pero no forma parte del flujo normal.

---

## Fase E — Remoto fuera de casa (Tailscale)
> Objetivo: conectar desde datos móviles, no solo la WiFi local.

- [x] **E.1** Detectar IP de Tailscale (`100.x.x.x`) si está instalado.
- [x] **E.2** Opción en ajustes: "Escuchar en Tailscale" en vez de la IP LAN.
- [x] **E.3** Nunca exponer el puerto directo a internet — Tailscale es el único camino remoto soportado.

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
