# Bento

**Bento** es un workspace de escritorio modular y open source. Una caja donde pones los paneles que quieras: reproductor TV, terminal real, navegador, notas, monitores, lo que se te ocurra.

Inspirado en VSCode, pero **genérico**: no asume que trabajas con código. Funciona en **Linux, macOS, Windows**. Paneles redimensionables, tabs, workspaces guardados, ventanas flotantes, multi-window.

> **Estado**: paneles Terminal, TV y Web funcionando, con sesiones, temas, layout tile/tabs y persistencia. Pendiente: ventanas flotantes y multi-window.

---

## 1. Visión

Un **workspace modular y personal** donde:

- Cada **panel** es independiente: TV, terminal, navegador, notas, lo que quieras.
- Los paneles se organizan en un **layout tile** (como VSCode) o flotante (como Photoshop).
- Puedes tener múltiples **tabs** dentro de cada panel (varias terminales, varios canales).
- Los layouts se guardan como **workspaces** — cada uno es una configuración completa.
- Las **ventanas flotantes** persisten entre workspaces.
- **Multi-window**: varios windows reales del SO, útil para 2+ monitores.
- **Open source** desde el principio: MIT license, aportes bienvenidos.

---

## 2. Stack técnico

| Componente | Decisión | Por qué |
|---|---|---|
| Framework app | **Tauri 2** | 5-15 MB binarios; WebView del sistema; backend Rust seguro |
| Backend | **Rust** | Requerido por Tauri; pty, plugins nativos |
| Frontend | **TypeScript + Vite** | Tipado, HMR rápido, soporte nativo de Tauri |
| Layout system | **Dockview** | Paneles tile + tabs + floating |
| Terminal | **xterm.js** + **portable-pty** | Emulador profesional; shell real |
| Reproducción | **hls.js** + **HTML5 Audio** | Streaming adaptativo |
| Persistencia | JSON en **~/.config/bento/** | Sin BBDD; versionable |
| Licencia | **MIT** | Máxima permisividad |

---

## 3. Desarrollo con Docker

El entorno de desarrollo corre 100% en Docker. No necesitas instalar Rust, Node ni nada más — solo Docker Desktop y un servidor X11 para mostrar la ventana gráfica.

### Prerrequisitos

Instala [Docker Desktop](https://www.docker.com/products/docker-desktop/) para tu SO.

Además, según tu SO, necesitas un servidor X11:

#### macOS

Instala [XQuartz](https://www.xquartz.org/) (vídeo) y PulseAudio (audio):

```bash
brew install --cask xquartz
brew install pulseaudio
```

Luego:
1. Abre XQuartz
2. Ve a **XQuartz → Preferences → Security**
3. Activa **"Allow connections from network clients"**
4. Cierra y vuelve a abrir XQuartz

`make dev` arranca PulseAudio automáticamente.

#### Linux

Ya tienes X11. No necesitas instalar nada extra.

#### Windows

Instala [VcXsrv](https://sourceforge.net/projects/vcxsrv/):

1. Descarga e instala VcXsrv
2. Lánzalo con **XLaunch**: selecciona "Multiple windows" → "Start no client" → activa **"Disable access control"**
3. VcXsrv quedará corriendo en la bandeja del sistema

---

### Primer uso (solo la primera vez)

```bash
git clone <repo>
cd bento
make setup
```

`make setup` construye la imagen Docker con Rust, Node, Tauri CLI y todas las dependencias.

---

### Desarrollar

#### macOS

```bash
# 1. Abre XQuartz (si no está abierto)
open -a XQuartz

# 2. Autoriza conexiones desde Docker
xhost +127.0.0.1

# 3. Lanza la app
make dev
```

#### Linux

```bash
make dev
```

#### Windows (PowerShell)

```powershell
# 1. Asegúrate de que VcXsrv está corriendo
# 2. Lanza la app
$env:DISPLAY = "host.docker.internal:0"
docker-compose run --rm bento sh -c 'dbus-run-session -- npm run tauri:dev'
```

---

### Otros comandos

```bash
make dev-native  # desarrollo nativo en el host (sin Docker)
make build       # genera binarios de distribución
make shell       # abre una shell dentro del contenedor
make test        # ejecuta los tests
```

> **Nota sobre el terminal**: dentro de Docker el WebView es WebKit2GTK
> sobre X11, que no enruta el teclado al terminal embebido (xterm.js).
> El resto de paneles funcionan. Para probar el terminal usa `make dev-native`
> (requiere Rust + Node en el host) o el binario distribuido — en WKWebView
> (macOS) y WebView2 (Windows) el teclado funciona con normalidad.

**Los binarios para distribución** (`.AppImage`, `.dmg`, `.msi`) se generan automáticamente en **GitHub Actions** (matrix: Linux/macOS/Windows) en cada push a `main`.

---

## 4. Estructura del proyecto

```
bento/
├── package.json / tsconfig.json / vite.config.ts
├── index.html
├── src/                               ← Frontend (TypeScript)
│   ├── main.ts                        ← composition root: registra paneles, monta la app
│   ├── app/                           ← createSessionManager, createWorkspaceView
│   ├── core/                          ← lógica pura testeada (session, terminal, channel, web, workspace)
│   ├── panels/                        ← terminal/, tv/, web/ + registry
│   ├── ui/                            ← commandPalette, contextMenu, icons, preferencias
│   ├── adapters/ · ports/             ← repos (canales, favoritos, estado) e interfaces
│   ├── assets/                        ← M3U bundled, etc.
│   └── styles.css
├── src-tauri/                         ← Backend (Rust)
│   ├── Cargo.toml · tauri.conf.json · icons/
│   └── src/
│       ├── main.rs                    ← comandos + arranque Tauri
│       ├── pty.rs                     ← terminal PTY (+ restaura cwd)
│       ├── web_panel.rs               ← webview nativo embebido
│       ├── traffic_lights.rs          ← semáforos macOS
│       ├── window_prefs.rs            ← decoraciones de ventana
│       └── workspace_io.rs            ← persistencia
├── tests/                             ← Vitest (núcleo puro)
└── README.md
```

---

## 5. Plan de implementación

- **Fase 0**: Setup entorno ✅
- **Fase 1**: Scaffold Tauri mínimo ✅
- **Fase 2**: Layout con paneles (Dockview: splits, mover, maximizar) ✅
- **Fase 3**: Panel TV (IPTV + hls.js, favoritos, embeds) ✅
- **Fase 4**: Terminal embebida (xterm.js + PTY, temas, perfiles, búsqueda) ✅
- **Fase 5**: Tabs dentro de paneles ✅
- **Fase 6**: Persistencia y sesiones (renombrar, duplicar, export/import) ✅
- **Fase 7**: Panel Web (webview nativo, bookmarks, historial) ✅
- **Fase 8**: Ventanas flotantes — pendiente
- **Fase 9**: Multi-window (varios windows del SO) — pendiente
- **Fase 10**: Pulido y distribución — en curso

---

## 6. Asistente de IA (opcional)

bento **no trae IA empaquetada**: es un workspace, no un agente. Pero como sus
terminales son reales, puedes correr ahí cualquier agente de IA. Lo único que
bento aporta es que **al reabrir, la terminal vuelve al proyecto donde estaba**
(vía OSC 7), así el agente trabaja sobre el código correcto.

El motor de contexto y el agente los instalas tú:

| Pieza | Rol | Instalación |
|-------|-----|-------------|
| [**lexis**](https://github.com/R0MADEV/lexis) | Motor de contexto: indexa el código y se lo da "masticado" al agente vía MCP | `cd lexis && npm link` |
| [**OpenCode**](https://opencode.ai) (o aider, cline, Claude Code…) | Agente que edita el código, multi-proveedor (gratis y de pago) | ver su web |

### Puesta en marcha

```bash
# 1. lexis disponible como comando (una vez)
cd /ruta/a/lexis && npm link

# 2. Conecta lexis como MCP a tu agente
lexis setup --client opencode --global    # o claude-code, cursor, cline…

# 3. En una terminal de bento, dentro de tu proyecto:
cd ~/mi-proyecto
lexis index .                 # indexa el proyecto (una vez)
opencode                      # o claude — el agente ya tiene el contexto de lexis
```

El flujo: **lexis** da el contexto preciso → el **agente** (con su propia key)
implementa los cambios. bento es el espacio donde todo ocurre.

> La API key la gestiona cada agente con su propio login (`opencode auth`, etc.).
> Para preguntas rápidas: `lexis ask "qué hace X"` con tu modelo configurado.

---

## 7. Licencia

MIT — libre para usar, modificar y distribuir.
