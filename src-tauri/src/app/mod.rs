//! El armazón de la aplicación: menú, ajustes, ventana, métricas del sistema y
//! el panel web incrustado. Nada de esto es un dominio del producto; es lo que
//! hace que la app sea una app.

#[cfg(target_os = "macos")]
pub mod global_hotkey;
pub mod menu;
pub mod settings;
pub mod system_metrics;
pub mod traffic_lights;
pub mod web_panel;
pub mod window_fit;
pub mod window_prefs;
pub mod workspace_io;
