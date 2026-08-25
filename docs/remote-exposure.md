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
| Tareas (worktrees), **solo lectura** | Responder "¿en qué anda cada rama?" desde fuera. Por HTTP va la lista; por el socket IPC va además el estado, el diff y el historial (`tasks.status`, `tasks.diff`, `tasks.log`, `tasks.upstream`), que el CLI usa. |
| Docker: listar contenedores, **solo lectura** | Saber qué se ha caído es la mitad de la razón para mirar el móvil. |

## No se expone, y no por ahora

| qué | por qué |
|---|---|
| **Vault** | Son secretos cifrados con la contraseña maestra. Exponerlos por HTTP cambia el modelo de amenaza entero: pasa de "quien tenga tu portátil desbloqueado" a "quien tenga el token". |
| **Bases de datos** | Las credenciales viven en el Vault y las consultas escriben. Un cliente SQL detrás de un token en la LAN es una puerta trasera al dato de producción. La lógica vive en `bento-db` (reutilizable), pero no se enchufa ni al socket IPC ni al HTTP. Construir el SQL también vive ahí (`bento_db::query`): entrecomillar un nombre o escapar un literal no puede estar escrito dos veces, una por lenguaje. |
| **Escrituras de tareas** (crear, borrar, commitear, rebasear, restaurar) | Son destructivas. Van por el socket IPC, que es local — el CLI las usa —, pero no por HTTP: un token en la LAN no es una confirmación. |
| **Ajustes y credenciales de Jira** | Mismo motivo que el Vault. |
| **Arrancar, parar o reiniciar contenedores** | Va por el socket IPC (el CLI lo usa), no por HTTP: parar la base de datos de producción desde el móvil no debería estar a un token de distancia. |
| **Preparar devcontainers** (aislar el compose, aplicar recetas) | Reescribe ficheros del worktree. Va por el socket IPC (el CLI lo usa), no por HTTP. |
| **Sesiones de los agentes** | Se leen del disco de quien lanzó el agente (`~/.claude`, `~/.codex`, la base de OpenCode). El CLI las lee en local y retomar una abre un PTY por el socket IPC; por HTTP no van. |
| **Notas y memorias** | Son apuntes del usuario sobre su trabajo. Se leen y escriben por el socket IPC, que es local; por HTTP no, porque un token en la LAN no es la misma confianza que tu portátil desbloqueado. |

## Antes de exponer algo nuevo

1. ¿Es lectura? Si escribe, ¿qué se rompe si alguien lo llama dos veces, o con
   los parámetros cambiados?
2. ¿Valida sus entradas en el propio handler compartido, y no solo en el
   transporte? (`is_safe_branch`, `is_safe_relative_path`.)
3. ¿Puede alguien con el token llegar a un secreto, directa o indirectamente?
