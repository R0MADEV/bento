# Bento

**Bento** is an open-source developer cockpit built with Tauri. A modular desktop workspace where you can open and arrange developer panels — Git worktrees, terminals, code review, databases, containers, scripts, and more — side by side, with a persistent layout that survives restarts.

Runs natively on **macOS, Linux, and Windows**.

---

![Bento home](assets/screenshots/home.png)

<details>
<summary>More screenshots</summary>

![Tasks](assets/screenshots/tareas.png)
![Changes](assets/screenshots/changes.png)
![Tech Review](assets/screenshots/tec-review.png)
![Database](assets/screenshots/database.png)
![Agent](assets/screenshots/agent.png)

</details>

---

## Panels

| Panel | What it does |
|-------|-------------|
| **Tasks** | Git worktrees per task — branch, changes, commit, PR, rebase, merge. Linear integration. Multi-repo. Docker devcontainer support. |
| **Terminal** | Real shell via xterm.js + PTY. Multiple terminals, profiles, themes, search, zoom, cwd restore on reopen. |
| **Tech Review** | AI-assisted code review. Set a base branch, browse changed files, open PRs, diff split/tree view, inline comments, chat with an AI agent. |
| **Diff** | Browse Git history or worktree changes. File list on the left, rendered patch on the right. Grouped log view per commit. |
| **DB** | Database explorer. Connect to SQLite, PostgreSQL, MySQL. Tree view of schemas and tables, query editor with results. |
| **Docker** | Container manager grouped by project. Start/stop individual containers or entire project groups. Logs and terminal per container. |
| **Jira** | Jira board inside Bento. Multiple accounts, board view, backlog, issue search, create and edit issues. |
| **Scripts** | Script runner. Scan folders for shell scripts, run them in an embedded terminal. Filter by folder. |
| **Notes** | Markdown notes as `.md` files. Categories, tags, preview, Ask-AI from sidebar. |
| **HTTP** | REST client. Methods, headers, body (JSON, form, raw), saved collections. Imports OpenAPI / Swagger specs as a browsable collection. |
| **TV** | IPTV player with HLS.js. M3U channel list (iptv-org), favourites, YouTube/Twitch embeds. |
| **Web** | Embedded browser (native WebView). Bookmarks and history per project. |

---

## Agent Integration

Bento detects running AI agent sessions (Claude Code, Codex, OpenCode) and shows their status in the sidebar. When you resume a workspace, agents that were active are highlighted so you can pick up where you left off.

Session detection works via:
- **Claude Code** — IPC socket + disk session files
- **Codex** — IPC socket
- **OpenCode** — disk session files

No API key is required on Bento's side. Each agent manages its own credentials.

---

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 20+
- On Linux: `libwebkit2gtk-4.1`, `libgtk-3`, `libayatana-appindicator3` (see [Tauri Linux deps](https://tauri.app/start/prerequisites/#linux))

### Install dependencies

```bash
git clone https://github.com/R0MADEV/bento
cd bento
npm install
```

### Run in development

```bash
npm run tauri:dev
```

### Build for distribution

```bash
npm run tauri:build
```

Produces a native binary (`.dmg` on macOS, `.AppImage`/`.deb` on Linux, `.msi`/`.exe` on Windows).

---

## Development

```bash
npm run dev          # frontend only (Vite, no Tauri shell)
npm run typecheck    # TypeScript — zero errors required
npm run lint         # ESLint
npm test             # Vitest (unit tests, no browser)
npm run ci:local     # full local CI: lint + typecheck + test + bindings + build
```

Generated Rust → TypeScript bindings live in `src/generated/bindings/`. Regenerate after changing Tauri DTOs:

```bash
npm run bindings:generate
npm run bindings:check   # CI fails if bindings are stale
```

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| App framework | **Tauri 2** | Native binaries 5–15 MB; system WebView; Rust backend |
| Backend | **Rust** | PTY, native filesystem, DB drivers, Docker IPC |
| Frontend | **TypeScript + Vite** | Type safety, fast HMR, first-class Tauri support |
| Layout | **dockview-core** | Tile panels + tabs, drag-and-drop, serialisable layout |
| Terminal | **xterm.js** + **portable-pty** | Real shell emulator; PTY spawned in Rust |
| Streaming | **hls.js** | Adaptive HLS for the TV panel |
| Tests | **Vitest** | Fast, no browser required for pure logic |
| Persistence | JSON in `~/.config/bento/` | No database; human-readable; versionable |
| License | **MIT** | Maximum permissiveness |

---

## Project Structure

```
bento/
├── src/                          # Frontend (TypeScript)
│   ├── main.ts                   # Composition root — registers panels, mounts app
│   ├── app/                      # createSessionManager, createWorkspaceView, home
│   ├── core/                     # Pure, tested logic (git, docker, memory, http, notes…)
│   ├── panels/                   # One folder per panel (tasks/, terminal/, diff/, …)
│   ├── ui/                       # Shared UI: collapsibleSidebar, icons, commandPalette, aiChat…
│   ├── adapters/ · ports/        # Repository implementations and interfaces
│   ├── i18n/                     # en.json / es.json
│   └── styles.css
├── src-tauri/                    # Backend (Rust)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs               # Tauri commands + app setup
│       ├── pty.rs                # PTY (terminal) + cwd restore
│       ├── git.rs                # Git operations
│       ├── docker.rs             # Docker container management
│       ├── db.rs                 # Database connections
│       ├── memory.rs             # Persistent memory store
│       ├── workspace_io.rs       # Workspace state persistence
│       └── …
├── tests/                        # Vitest — unit tests for src/core and src/ui
└── scripts/                      # Dev scripts (bindings, i18n audit, memory tools)
```

---

## Contributing

Pull requests are welcome. Before opening one:

1. Run `npm run ci:local` — it must pass with zero errors.
2. Follow the commit convention: `feat: added …` / `fix: corrected …`
3. Branch names: `feat/short-description` or `fix/short-description`

---

## License

MIT — free to use, modify and distribute.
