# Panel Web — navegador embebido en la app

Un panel de bento que carga **cualquier URL** dentro de la app (WhatsApp Web, Jira,
Facebook, Gmail…), no solo las que permiten iframe.

## Por qué NO es un `<iframe>`

La mayoría de sitios serios (Google, WhatsApp, Jira, Facebook) mandan la cabecera
`X-Frame-Options: SAMEORIGIN` o `Content-Security-Policy: frame-ancestors`, que
**bloquean la carga dentro de un iframe**. Es una restricción del servidor: no hay
forma de saltarla desde el cliente. Por eso el iframe sale en negro.

La única solución real es un **webview nativo** del sistema (WKWebView en macOS),
que es un motor de navegador independiente sin esas restricciones.

## Arquitectura: `Window::add_child` (NO `WebviewWindowBuilder`)

Tauri 2 ofrece dos formas de crear un webview nativo. **Usamos la primera:**

| API | Qué crea | Coordenadas | ¿Sirve aquí? |
|-----|----------|-------------|--------------|
| `window.add_child(...)` | Un webview **hijo dentro** de la ventana principal | **Relativas a la ventana** | ✅ SÍ |
| `WebviewWindowBuilder` | Una **ventana del SO separada** | Absolutas de pantalla | ❌ NO |

`add_child` incrusta el webview dentro de la ventana de bento usando coordenadas
relativas a la ventana — que es **exactamente** lo que `getBoundingClientRect()`
devuelve. Cero conversión de coordenadas. El webview se solapa sobre el `div`
placeholder del panel.

> ⚠️ `add_child`, `WebviewBuilder` y la API multi-webview están detrás del
> **feature `unstable`** de Tauri. Sin ese flag, `cargo` da
> `unresolved import tauri::WebviewBuilder` / `no method named add_child`.

## Cómo funciona (flujo)

```
TS (WebPanel.ts)                         Rust (web_panel.rs)
────────────────                         ───────────────────
getBoundingClientRect()  ──navigate──▶   window.add_child(WebviewBuilder, pos, size)
   { rectX, rectY, w, h }                 (webview nativo dentro de la ventana)

ResizeObserver           ──set_bounds─▶   wv.set_position() + wv.set_size()
(panel cambia de tamaño)

IntersectionObserver     ──set_visible▶   wv.show() / wv.hide()
(tab oculto por dockview)

dispose()                ──close──────▶   wv.close()
```

- **El `div.web-content` es solo un hueco/placeholder.** No contiene nada; solo
  sirve para medir dónde y de qué tamaño debe ir el webview nativo encima.
- El `ResizeObserver` reposiciona el webview cuando el panel cambia de tamaño
  (split, resize de la ventana, etc.).
- El `IntersectionObserver` lo oculta cuando el panel deja de verse (cambio de
  pestaña en dockview) y lo muestra al volver.

## Archivos

| Archivo | Rol |
|---------|-----|
| `src/panels/web/WebPanel.ts` | UI (barra de URL + placeholder) y los `invoke` a Rust |
| `src/panels/web/definition.ts` | Registra el tipo de panel `web` |
| `src/core/web/normalizeUrl.ts` | `example.com` → `https://example.com` (con tests) |
| `src-tauri/src/web_panel.rs` | Los 4 comandos Rust + el `WebPanelState` |
| `src-tauri/src/main.rs` | Registra `WebPanelState` y los comandos en el handler |
| `src/main.ts` | `panels.register(webPanelDefinition)` |

## Comandos Rust (`web_panel.rs`)

Estado compartido: `WebPanelState { panels: Mutex<HashMap<String, tauri::Webview>> }`
— un webview por panel, indexado por su `id` (`web-panel-1`, `web-panel-2`…).

- `web_panel_navigate(id, url, rect_x, rect_y, width, height)` — crea el webview
  hijo la primera vez; en llamadas siguientes solo navega + reposiciona.
- `web_panel_navigate(id, url, rect, user_agent)` — crea/navega; recibe el UA
  (opcional) y **recrea** el webview si el UA cambió (el UA es inmutable tras crear).
- `web_panel_set_bounds(id, rect_x, rect_y, width, height)` — mueve/redimensiona.
- `web_panel_set_visible(id, visible)` — show/hide.
- `web_panel_close(id)` — cierra y lo saca del map.
- `web_panel_close_all()` — cierra todos (limpieza al arrancar el frontend).

## User-Agent por sitio (Chrome ↔ Safari)

El UA se elige **por host** y se guarda en `localStorage` (`bento.web.ua`):

| Sitio | UA recomendado | Por qué |
|-------|----------------|---------|
| WhatsApp, Jira… | **Chrome** (default) | rechazan WKWebView "Safari viejo" |
| Google / Gmail login | **Safari** nativo | con UA de Chrome falso Google detecta el desajuste |

Lógica pura testeada en `src/core/web/userAgent.ts` (`resolveUserAgent`, `hostOf`,
`getUaMode`, `setUaMode`). El selector está en la barra del panel; al cambiarlo se
guarda para ese host y se recarga (Rust ve el UA distinto → recrea el webview).

> ⚠️ **Login de Google sigue sin funcionar embebido aunque pongas Safari.** Google
> bloquea *cualquier* webview embebido por política anti-phishing
> ("navegador o aplicación no seguros"). No es un bug nuestro; no hay fix desde el
> cliente. Para Gmail: usar el navegador externo.

## Qué se necesita (checklist para reproducir)

1. **`Cargo.toml`**: `tauri = { version = "2", features = ["unstable"] }`
   ← imprescindible, sin esto no compila `add_child`.
2. **`main.rs`**: `.manage(web_panel::WebPanelState::default())` +
   los comandos en `tauri::generate_handler![...]`.
3. **User-Agent**: se pasa por `web_panel_navigate`; por defecto Chrome. Ver
   `src/core/web/userAgent.ts` y la sección de arriba.
4. **CSP** en `tauri.conf.json` ya permite recursos externos (`frame-src *`,
   `connect-src ... https://*`).
5. Tras tocar Rust o `Cargo.toml`: **reiniciar `npm run tauri dev`** (el
   hot-reload del frontend NO recompila el backend).

## Errores que ya cometimos (no repetir)

- ❌ **iframe** → negro, los sitios bloquean embedding con `X-Frame-Options`.
- ❌ **`WebviewWindowBuilder` + coordenadas de pantalla** → la ventana salía
   pegada al lado del panel, no encima. El cálculo
   `inner_position()/scale + rect` era frágil (multi-monitor, Retina). Abandonado
   en favor de `add_child`.
- ❌ **`window.screenLeft/screenTop`** → no es fiable en WKWebView, devolvía 0.
- ❌ **olvidar el feature `unstable`** → `add_child` no existe, no compila.

## Limitaciones conocidas

- El webview nativo **se dibuja siempre por encima** del DOM. No se puede poner un
  overlay HTML (menú, popover) encima del área del navegador; habría que ocultar
  el webview (`set_visible false`) mientras se muestra el overlay.
- No hay historial atrás/adelante todavía (solo barra de URL + recargar). Si se
  quiere, Tauri `Webview` no expone `go_back` directamente; habría que inyectar
  `history.back()` vía `eval`.
- La posición se sincroniza por observers; en cambios de layout muy rápidos puede
  haber un frame de desfase.
