# Bento Daemon

Proceso de fondo multiplataforma que centraliza la gestión de terminales y agentes.
Tanto el CLI como la app GUI se conectan a él. El servidor de control desde el móvil
también vive aquí — así funciona aunque la app no esté abierta.

---

## Por qué un daemon

Sin daemon, los PTY y agentes viven dentro del proceso Tauri. Si usas el CLI
sin abrir la app, no hay terminales, no hay agentes y el móvil no puede conectar.

Con daemon:

```
┌──────────────────────────────────────────────────┐
│               bento-daemon                       │
│  (corre en background, arranca con el sistema)   │
│                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌────────┐  │
│  │ PTY manager │  │ Agent manager│  │ HTTP   │  │
│  │ (pty.rs)    │  │ (agent/mod)  │  │ server │  │
│  └─────────────┘  └──────────────┘  │ móvil  │  │
│                                     └────────┘  │
│         IPC: TCP localhost / named pipe          │
└──────┬───────────────────┬──────────────────────┘
       │                   │                  │
       ▼                   ▼                  ▼
  bento (CLI)       Bento (app GUI)        📱 Móvil
  $ bento agents    Tauri conecta          Navegador
  $ bento run       al daemon              conecta al
                                           HTTP server
```

---

## Decisiones de diseño cross-platform

### IPC (comunicación CLI/GUI ↔ daemon)

| Mecanismo | macOS | Linux | Windows | Elección |
|---|---|---|---|---|
| Unix socket | ✅ | ✅ | ⚠️ solo Win10+ | No (riesgo Windows) |
| Named pipe | ✅ (`/tmp/`) | ✅ | ✅ (`\\.\pipe\`) | **Sí — Fase 2+** |
| TCP localhost | ✅ | ✅ | ✅ | **Sí — Fase 1 (más simple)** |

**Fase 1:** TCP en `127.0.0.1:7877` (puerto configurable). Simple, funciona en todo.
**Fase 2:** Migrar a named pipes para no consumir un puerto de red.

### PTY
Ya usa `portable_pty` (cross-platform). Sin cambios.

### Auto-arranque con el sistema

| Plataforma | Mecanismo | Archivo |
|---|---|---|
| macOS | launchd | `~/Library/LaunchAgents/dev.bento.daemon.plist` |
| Linux | systemd user | `~/.config/systemd/user/bento-daemon.service` |
| Windows | Task Scheduler / registro | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` |

El daemon no asume ningún mecanismo concreto — se registra/desregistra
con comandos (`bento daemon install` / `bento daemon uninstall`).

### Binarios resultantes

```
bento-daemon   → proceso de fondo (nuevo binario Rust en src-tauri/)
bento          → CLI (nuevo binario Rust, comunica con el daemon)
Bento.app      → app GUI Tauri (comunica con el daemon en vez de gestionar PTY directamente)
```

---

## Protocolo IPC (TCP localhost)

Mensajes JSON por línea (`\n`-delimited), bidireccionales.

### Peticiones del cliente → daemon

```jsonc
// Listar terminales abiertos
{ "id": "1", "cmd": "terminals.list" }

// Abrir nuevo terminal
{ "id": "2", "cmd": "terminal.open", "cwd": "/home/user/project", "shell": "auto" }

// Escribir en un terminal
{ "id": "3", "cmd": "terminal.write", "pty_id": "pty-1", "data": "ls -la\r" }

// Cerrar terminal
{ "id": "4", "cmd": "terminal.close", "pty_id": "pty-1" }

// Suscribirse a la salida de un terminal
{ "id": "5", "cmd": "terminal.subscribe", "pty_id": "pty-1" }

// Lanzar agente
{ "id": "6", "cmd": "agent.run", "agent": "claude", "cwd": "/project", "message": "..." }

// Estado del daemon
{ "id": "7", "cmd": "daemon.status" }
```

### Respuestas y eventos daemon → cliente

```jsonc
// Respuesta a una petición
{ "id": "1", "ok": true, "data": [ { "pty_id": "pty-1", "title": "zsh", "cwd": "/home/..." } ] }

// Evento de salida de PTY (push, tras suscribirse)
{ "event": "terminal.output", "pty_id": "pty-1", "data": "$ " }

// Evento de cierre de PTY
{ "event": "terminal.exit", "pty_id": "pty-1", "code": 0 }

// Error
{ "id": "3", "ok": false, "error": "pty_id not found" }
```

---

## Fases de implementación

### Fase 1 — daemon mínimo funcional
> El daemon arranca, gestiona PTYs y el CLI puede hablar con él.

- [ ] **1.1** Nuevo crate `bento-daemon` en el workspace Cargo:
  - `src-tauri/bento-daemon/src/main.rs`
  - deps: `tokio`, `serde_json`, `portable_pty`

- [ ] **1.2** Mover/adaptar `pty.rs` para que compile fuera de Tauri:
  - Extraer a crate compartida `bento-core` (PTY manager sin dependencias Tauri)
  - `bento-daemon` y `src-tauri` (Tauri app) importan `bento-core`

- [ ] **1.3** Servidor IPC TCP en `127.0.0.1:7877`:
  - Acepta múltiples clientes simultáneos (tokio tasks)
  - Implementa los comandos: `terminals.list`, `terminal.open`, `terminal.write`,
    `terminal.close`, `terminal.subscribe`

- [ ] **1.4** Nuevo crate `bento-cli`:
  - `bento-cli/src/main.rs`
  - Comandos iniciales:
    - `bento daemon start` / `stop` / `status`
    - `bento terminals` — lista terminales
    - `bento open [--cwd <path>]` — abre un terminal
    - `bento attach <pty_id>` — conecta al terminal (stdin/stdout del CLI)

- [ ] **1.5** Tests:
  - El daemon arranca y responde a `daemon.status`
  - Abrir → escribir → suscribirse → recibir output → cerrar un PTY
  - Múltiples clientes suscritos al mismo PTY reciben el mismo output

---

### Fase 2 — App Tauri habla con el daemon
> La app GUI deja de gestionar PTYs directamente y los delega al daemon.

- [ ] **2.1** La app Tauri detecta si el daemon está corriendo al arrancar:
  - Si no → lo lanza como proceso hijo (modo embebido)
  - Si sí → se conecta al existente

- [ ] **2.2** Adaptar los comandos Tauri existentes (`pty_spawn`, `pty_write`, `pty_kill`…)
  para que pasen por el daemon en vez de gestionar PTYs directamente

- [ ] **2.3** Los eventos `pty-output-*` siguen llegando al frontend igual (el daemon
  los retransmite por el canal IPC → Tauri → WebView)

- [ ] **2.4** Named pipes (opcional en esta fase):
  - macOS/Linux: `$TMPDIR/bento-daemon.sock`
  - Windows: `\\.\pipe\bento-daemon`

---

### Fase 3 — Auto-arranque + comandos de agentes en el CLI

- [ ] **3.1** `bento daemon install` → registra el auto-arranque en el sistema:
  - macOS: escribe `~/Library/LaunchAgents/dev.bento.daemon.plist`
  - Linux: escribe `~/.config/systemd/user/bento-daemon.service` y hace `systemctl --user enable`
  - Windows: añade entrada en el registro `HKCU\...\Run`

- [ ] **3.2** `bento daemon uninstall` → revierte el registro

- [ ] **3.3** Comandos de agentes en el CLI:
  - `bento agent run claude --cwd <path> --message "..."`
  - `bento agent list`
  - `bento agent attach <id>`

---

### Fase 4 — Servidor HTTP para el móvil (enlaza con `feat/phone-remote-control`)

- [ ] **4.1** Añadir servidor HTTP/WS al daemon (no a la app Tauri):
  - Así funciona aunque la app esté cerrada
  - Ver plan completo en `PHONE_REMOTE.md`

---

## Estructura de ficheros propuesta

```
bento/
├── src-tauri/                  ← app Tauri (existente)
│   ├── Cargo.toml              (modificado: añade bento-core como dep)
│   └── src/
│       └── pty.rs              (simplificado: delega a bento-core)
│
├── bento-core/                 (NUEVO crate compartido)
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs
│       ├── pty.rs              (gestión de PTY sin dependencias Tauri)
│       └── agent.rs            (gestión de agentes sin dependencias Tauri)
│
├── bento-daemon/               (NUEVO binario)
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs             (arranque, señales OS, PID file)
│       ├── ipc.rs              (servidor TCP, protocolo JSON)
│       └── autostart.rs        (install/uninstall por plataforma)
│
├── bento-cli/                  (NUEVO binario)
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs
│       ├── client.rs           (conecta al daemon por TCP)
│       └── commands/
│           ├── daemon.rs
│           ├── terminals.rs
│           └── agents.rs
│
└── Cargo.toml                  (workspace, modificado: añade los nuevos crates)
```

---

## Orden de implementación

```
Fase 1 (daemon mínimo + CLI básico)
    → Fase 2 (app Tauri delega al daemon)
        → Fase 3 (auto-arranque + agentes en CLI)
            → Fase 4 (servidor HTTP móvil en el daemon)
                → feat/phone-remote-control (UI móvil)
```

La **Fase 1** es la más crítica y la más diferente a lo que existe.
Las fases 2-4 son incrementales sobre ella.

---

## Preguntas abiertas

- [ ] ¿Puerto IPC fijo (7877) o dinámico con PID file?
- [ ] ¿El daemon escribe logs a fichero o solo a stderr?
- [ ] ¿El CLI necesita TUI (interfaz interactiva) o solo salida de texto?
- [ ] ¿En Windows, usar Windows Service o simplemente el registro de arranque?
