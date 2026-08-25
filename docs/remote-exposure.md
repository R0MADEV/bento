# Qué se expone fuera de la app, y qué no

El daemon sirve dos caminos que no son la app de escritorio: el socket IPC
(local, para el CLI y el TUI) y el servidor HTTP del móvil (LAN o Tailscale,
protegido por un token). Todo lo que se añade ahí amplía la superficie, así
que la regla es explícita.

## Se expone

| qué | por qué |
|---|---|
| Terminales | Es el caso de uso original: seguir un agente desde el móvil. |
| Review (diff, PRs, comentarios, correr la review) | Revisar es leer y comentar; el agente corre en modo solo lectura y sobre un worktree aislado. |
| Proyectos abiertos | Solo rutas y rama, para elegir sobre qué proyecto trabajar. |
| Tareas (worktrees), **solo lectura** | Responder "¿en qué anda cada rama?" desde fuera. |

## No se expone, y no por ahora

| qué | por qué |
|---|---|
| **Vault** | Son secretos cifrados con la contraseña maestra. Exponerlos por HTTP cambia el modelo de amenaza entero: pasa de "quien tenga tu portátil desbloqueado" a "quien tenga el token". |
| **Bases de datos** | Las credenciales viven en el Vault y las consultas escriben. Un cliente SQL detrás de un token en la LAN es una puerta trasera al dato de producción. |
| **Escrituras de tareas** (crear, borrar, rebasear un worktree) | Son destructivas y en la app tienen confirmación, historial y backup. Sin esa red, no. |
| **Ajustes y credenciales de Jira** | Mismo motivo que el Vault. |

## Antes de exponer algo nuevo

1. ¿Es lectura? Si escribe, ¿qué se rompe si alguien lo llama dos veces, o con
   los parámetros cambiados?
2. ¿Valida sus entradas en el propio handler compartido, y no solo en el
   transporte? (`is_safe_branch`, `is_safe_relative_path`.)
3. ¿Puede alguien con el token llegar a un secreto, directa o indirectamente?
