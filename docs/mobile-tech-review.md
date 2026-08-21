# Mobile Tech Review

AI-assisted code review accessible from any phone browser, powered by the bento-daemon and the `claude` CLI.

## How it works

The existing Phone Remote panel already runs an Axum HTTP server inside `bento-daemon`. Mobile Tech Review adds two new endpoints to that same server and a **Review** tab to the embedded HTML page.

```
Phone browser
  │  GET /api/projects?token=…
  │  GET /api/review?token=…&cwd=/path&base=main   ← SSE stream
  │
  ▼
bento-daemon  (Axum, port 7879)
  │  git diff <base>..HEAD  (in cwd)
  │  build review prompt (ported from buildReviewPrompt in techReview.ts)
  │  spawn claude -p "<prompt>" --output-format stream-json \
  │         --allowedTools Read,Glob,Grep
  │  parse each JSON event line → extract text chunks
  │  emit as SSE text/event-stream
  ▼
rendered Markdown in the phone browser
```

## New endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/projects` | Returns unique cwds of active terminals with their git branch |
| `GET` | `/api/review` | SSE stream — runs claude review for a given `cwd` + `base` branch |

### `/api/projects`

```
GET /api/projects?token=<token>

200 OK  application/json
[
  { "cwd": "/home/user/project", "branch": "feat/my-feature" },
  …
]
```

Deduplicates terminals by cwd. A terminal with an empty cwd is omitted.

### `/api/review`

```
GET /api/review?token=<token>&cwd=/home/user/project&base=main

200 OK  text/event-stream
data: ## Correctness\n\nNo issues found.\n\n
data: ## Security\n\n…
…
data: [DONE]
```

SSE format: one `data:` line per text chunk from the model. The final event is `data: [DONE]`.

On error (no diff, claude not found, non-zero exit), a single `data: [ERROR] <message>` event is sent before the stream closes.

## Phone UI changes

The embedded HTML gains a second tab — **Review** — alongside the existing **Terminals** tab.

```
┌─────────────────────────────────────────┐
│  Terminals │ Review                     │  ← tab bar
├─────────────────────────────────────────┤
│  Proyecto                               │
│  ┌──────────────────────────────┐       │
│  │ /home/user/project  ▾        │       │  ← project picker
│  └──────────────────────────────┘       │
│                                         │
│  Rama base                              │
│  ┌──────────────────────────────┐       │
│  │ main                         │       │  ← text input
│  └──────────────────────────────┘       │
│                                         │
│  ┌──────────────────────────────┐       │
│  │  Iniciar revisión            │       │  ← start button
│  └──────────────────────────────┘       │
│                                         │
│  [streaming markdown output here]       │
└─────────────────────────────────────────┘
```

Markdown is rendered progressively as SSE chunks arrive using a minimal inline renderer (no external deps — just regex replacements for headings, bold, code, lists).

## Files changed

| File | Change |
|------|--------|
| `daemon/bento-daemon/src/remote.rs` | Add `review_handler`, `projects_handler`, SSE helpers, review prompt builder; register routes; extend `MOBILE_HTML` with Review tab |

## Review prompt

Ported from `src/core/ai/techReview.ts → buildReviewPrompt`. The Rust version builds the same Spanish-language system prompt covering:

- Correctness and logic
- Security (injection, auth, data exposure)
- Breaking changes (API surface, serialization, DB schema)
- Performance (N+1, allocations, blocking I/O)
- Error handling and recovery
- Concurrency and thread safety
- Code quality and maintainability
- Test coverage

The diff is embedded at the end of the prompt; claude reads it via stdin (`-p`).

## Prerequisites

- `claude` CLI must be in `$PATH` on the machine running bento-daemon
- The project must be a git repository with at least one commit ahead of the base branch
- Phone Remote server must be active (started from the Phone Remote panel)
