# Tareas: integración con Jira + flujo git completo

Ampliación del **Panel de Tareas Paralelas**. El objetivo es cerrar el ciclo de
trabajo sin salir del panel: **crear tarea → ver de qué va (Jira) → trabajar →
ver cambios → commitear → subir → PR → sincronizar**.

Rama: `feat/tasks-jira-and-git-workflow`.

---

## 1. Integración con Jira

Aprovecha toda la infraestructura ya existente del panel Jira. **No hace falta
tocar el backend**: las llamadas van por el comando Tauri `http_request` que ya
está registrado.

### Piezas reutilizables (ya en el repo)
- `invoke('jira_config_get')` → `{ site, email, token }`
- `basicAuth(email, token)` — `src/core/jira/auth.ts`
- `apiUrl(site, path)`, `browseUrl(site, key)` — `src/core/jira/urls.ts`
- `parseIssues(json)` — `src/core/jira/issues.ts`
- `http_request` (Tauri) — método, url, headers, body

### Qué hay que construir
Un módulo nuevo `src/core/git/taskJira.ts` (lógica pura, testeable):

- [ ] `extractIssueKey(branch: string): string | null`
      Regex `/[A-Z][A-Z0-9]+-\d+/` sobre el nombre de rama.
      `feat/IVOZ-1234-add-portal` → `IVOZ-1234`. Con test (TDD).

Y un helper de UI `src/panels/tasks/taskJiraClient.ts` (usa `http_request`):

- [ ] `fetchIssue(key)` → `GET api/3/issue/{key}?fields=summary,status`
- [ ] `fetchTransitions(key)` → `GET api/3/issue/{key}/transitions`
- [ ] `applyTransition(key, transitionId)` → `POST api/3/issue/{key}/transitions`
- [ ] Todos con fallback silencioso: si Jira no está configurado o la rama no
      tiene ticket, no se muestra nada (la fila queda como ahora).

### UI en `TasksPanel.ts`
- [ ] Al cargar tareas, para cada rama con ticket, pedir el issue (en paralelo).
- [ ] Mostrar en la fila: **título del ticket** + chip de estado
      (To Do / En curso / Done) con las clases de color de Jira
      (`jira-st-todo` / `jira-st-progress` / `jira-st-done`).
- [ ] Menú `⋯`:
  - [ ] **Abrir en Jira** → `browseUrl(site, key)` en el navegador.
  - [ ] **Cambiar estado** → submenú con las transiciones disponibles;
        al elegir una, `applyTransition` y refrescar la fila.

### Resultado
```
● IVOZ-1234 · Añadir portal brand   [En curso] [2 cambios] ⋯
  feat/IVOZ-1234-add-portal
```

---

## 2. Lado de escritura de git (cierra el flujo)

Ahora se puede *ver* el diff y sincronizar, pero para commitear/subir hay que ir
a la terminal. Añadir los comandos que faltan.

### Backend (`src-tauri/src/git.rs`)
- [ ] `git_commit(path, message)` → `git add -A && git commit -m <msg>`.
      Validar mensaje no vacío (trust boundary).
- [ ] `git_push(path)` → `git push`. Si la rama no tiene upstream,
      `git push -u origin <branch>` (detectar la rama actual).
- [ ] `git_ahead_behind(path, base)` → `git rev-list --left-right --count origin/<base>...HEAD`
      devuelve `{ ahead, behind }`.
- [ ] `git_create_pr(path, base)` → `gh pr create --fill --base <base>`
      (requiere `gh` instalado; fallback: abrir la URL de comparación).
      Registrar todos en `main.rs`.

### Frontend (`TasksPanel.ts`)
- [ ] **Commit desde el diff** — en la vista de cambios, campo de mensaje +
      botón "Commit". Tras commitear, refrescar el diff (queda vacío) y el badge.
- [ ] **Push** — opción en el menú `⋯`.
- [ ] **Crear PR** — opción en el menú `⋯` (solo si la rama tiene commits por
      delante de `origin/<base>`).
- [ ] **Indicador ↑/↓** — en la fila, mostrar `↑2 ↓3` (ahead/behind) para saber
      de un vistazo qué tareas necesitan sync o push. Punto naranja si `behind > 0`.

---

## 3. Seguridad / robustez

- [ ] **Stash automático antes de sync** — hoy `merge`/`rebase` se bloquean si
      hay cambios sin commitear. Alternativa más flexible: ofrecer
      `git stash → sync → git stash pop`. Preguntar al usuario (confirm dialog)
      antes de hacerlo. Backend: `git_sync` acepta un flag `autostash`
      (o usar `--autostash` en rebase; para merge, stash manual).

---

## 4. Comodidad (opcional, menor prioridad)

- [ ] **Terminal del worktree** — abrir una terminal en el directorio del
      worktree (no dentro de contenedor), para comandos ad-hoc. Reutiliza
      `createTerminalPanel` con `cwd = wt.path`.
- [ ] **Recordar tarea seleccionada** — persistir en `localStorage` la última
      tarea abierta y reabrirla al arrancar.
- [ ] **Copiar nombre de rama** — opción en el menú `⋯` para pegar en Jira/PR.

---

## Orden sugerido de implementación
1. Jira (módulo + cliente + UI) — es lo más autónomo y de mayor valor.
2. Git write-side (commit → push → PR → indicador ↑↓).
3. Stash automático.
4. Comodidades.

## Reglas del proyecto a respetar
- TDD para la lógica no trivial (`extractIssueKey`, `git_ahead_behind` parseo).
  Tests vía **signal MCP** (`run_check tests` / `test`).
- Validación de input en los comandos Rust (mensajes, rutas, ramas).
- Sin duplicar: reutilizar `apiUrl`/`basicAuth`/`http_request` y
  `showContextMenu`/`askAi` que ya existen.
- Commits: `tag: verbo en pretérito + lo que hace`. Sin línea de coautoría.
