# Bento

**Bento** es un workspace de escritorio modular y open source. Una caja donde pones los paneles que quieras: reproductor TV, terminal real, navegador, notas, monitores, lo que se te ocurra.

Inspirado en VSCode, pero **genérico**: no asume que trabajas con código. Funciona en **Linux, macOS, Windows**. Paneles redimensionables, tabs, workspaces guardados, ventanas flotantes, multi-window.

> **Estado**: Fase 1 (setup entorno + scaffold Tauri mínimo).

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

El entorno de desarrollo corre en Docker — no necesitas instalar Rust ni Node localmente.

### Primera vez

```bash
make setup   # construye la imagen Docker
```

### Desarrollar

```bash
make dev     # arranca Tauri + Vite con hot reload
```

`make dev` detecta tu SO automáticamente:

- **Linux**: usa tu display directamente.
- **macOS**: instala y configura XQuartz si no lo tienes (sigue las instrucciones en pantalla).
- **Windows**: necesitas [VcXsrv](https://sourceforge.net/projects/vcxsrv/) instalado y corriendo.

### Otros comandos

```bash
make build   # genera binarios de distribución
make shell   # abre una shell dentro del contenedor
```

**Los binarios para distribución** (`.AppImage`, `.dmg`, `.msi`) se generan en **GitHub Actions** (matrix: Linux/macOS/Windows).

---

## 4. Estructura del proyecto

```
bento/
├── Dockerfile / docker-compose.yml   ← dev environment
├── package.json / tsconfig.json / vite.config.ts
├── index.html
├── src/                              ← Frontend (TypeScript)
│   ├── main.ts
│   ├── workspace/
│   ├── panels/
│   ├── floating/
│   └── styles.css
├── src-tauri/                        ← Backend (Rust)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/main.rs
├── .github/workflows/build.yml       ← CI/CD
└── README.md
```

---

## 5. Plan de implementación (10 fases)

- **Fase 0**: Setup entorno ✅
- **Fase 1**: Scaffold Tauri mínimo (en progreso)
- **Fase 2**: Layout con dos paneles
- **Fase 3**: Panel TV funcionando
- **Fase 4**: Terminal embebida
- **Fase 5**: Tabs dentro de paneles
- **Fase 6**: Persistencia y workspaces
- **Fase 7**: Ventanas flotantes
- **Fase 8**: Multi-window
- **Fase 9**: Pulido y distribución

---

## 6. Licencia

MIT — libre para usar, modificar y distribuir.
