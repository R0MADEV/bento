# Bento

**Bento** es un workspace de escritorio modular y open source. Una caja donde pones los paneles que quieras: reproductor TV, terminal real, navegador, notas, monitores, lo que se te ocurra.

Inspirado en VSCode, pero **genérico**: no asume que trabajas con código. Funciona en **Linux, macOS, Windows**. Paneles redimensionables, tabs, workspaces guardados, ventanas flotantes, multi-window.

> **Estado**: Fase 1 ✅ — ventana Tauri funcionando en Docker.

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

Instala [XQuartz](https://www.xquartz.org/):

```bash
brew install --cask xquartz
```

Luego:
1. Abre XQuartz
2. Ve a **XQuartz → Preferences → Security**
3. Activa **"Allow connections from network clients"**
4. Cierra y vuelve a abrir XQuartz

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
make build   # genera binarios de distribución
make shell   # abre una shell dentro del contenedor
```

**Los binarios para distribución** (`.AppImage`, `.dmg`, `.msi`) se generan automáticamente en **GitHub Actions** (matrix: Linux/macOS/Windows) en cada push a `main`.

---

## 4. Estructura del proyecto

```
bento/
├── Makefile                           ← comandos de desarrollo
├── Dockerfile / docker-compose.yml    ← entorno Docker
├── scripts/setup-display.sh          ← configura X11 por SO
├── package.json / tsconfig.json / vite.config.ts
├── index.html
├── src/                               ← Frontend (TypeScript)
│   ├── main.ts
│   ├── workspace/                     ← tipos y manager de workspaces
│   ├── panels/                        ← TV, terminal, notas
│   ├── floating/                      ← ventanas flotantes
│   └── styles.css
├── src-tauri/                         ← Backend (Rust)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── icons/
│   └── src/
│       ├── main.rs
│       ├── pty.rs                     ← terminal PTY (Fase 4)
│       └── workspace_io.rs            ← persistencia (Fase 6)
├── .github/workflows/build.yml        ← CI/CD
└── README.md
```

---

## 5. Plan de implementación

- **Fase 0**: Setup entorno ✅
- **Fase 1**: Scaffold Tauri mínimo ✅ — ventana funcionando en Docker
- **Fase 2**: Layout con dos paneles (Dockview)
- **Fase 3**: Panel TV funcionando (IPTV + hls.js)
- **Fase 4**: Terminal embebida (xterm.js + PTY)
- **Fase 5**: Tabs dentro de paneles
- **Fase 6**: Persistencia y workspaces
- **Fase 7**: Ventanas flotantes
- **Fase 8**: Multi-window
- **Fase 9**: Pulido y distribución

---

## 6. Licencia

MIT — libre para usar, modificar y distribuir.
