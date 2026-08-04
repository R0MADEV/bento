# Recetas de devcontainer en el panel Tareas

Bento puede aplicar archivos locales a cada worktree sin añadirlos al repositorio
del proyecto. Las recetas viven en una carpeta persistente y el ajuste de Bento
solo guarda un puntero a esa carpeta.

## Configuración inicial

1. Abre un panel **Tareas**.
2. Selecciona el repositorio principal, no la carpeta de un worktree.
3. Pulsa el engranaje del panel.
4. Selecciona el directorio raíz de recetas, por ejemplo `~/bento-recipes`.

Sin este ajuste Bento mantiene el aislamiento genérico de Docker, pero no copia
ninguna receta.

## Añadir un proyecto

Dentro del directorio de recetas crea una carpeta cuyo nombre sea exactamente el
nombre de la carpeta del repositorio principal (`basename`).

Para este repositorio:

```text
/Users/alguien/proyectos/mi-api
```

la receta debe empezar en:

```text
~/bento-recipes/mi-api/
```

Coloca dentro únicamente los archivos locales que quieras aplicar, conservando la
misma ruta relativa que tendrán en el proyecto:

```text
~/bento-recipes/
└── mi-api/
    ├── .env
    ├── .devcontainer/
    │   ├── docker-compose.override.yml
    │   └── bento-postcreate.sh
    └── apps/foo/config.local.json
```

Cuando Bento prepare una tarea, los archivos anteriores se copiarán al worktree
como `.env`, `.devcontainer/docker-compose.override.yml`,
`.devcontainer/bento-postcreate.sh` y `apps/foo/config.local.json`.

Si la receta incluye `docker-compose.override.yml` o `bento-postcreate.sh` dentro
del `.devcontainer` detectado, Bento los conecta automáticamente en
`devcontainer.json`.

También puedes hacerlo desde el engranaje del panel **Tareas** con **Crear receta
para este proyecto**. Bento crea la carpeta del proyecto y su `.devcontainer`.

La clave de receta usa por defecto el nombre del repositorio. Si tienes dos
repositorios con el mismo nombre, cambia **Clave de receta del proyecto** por una
clave única, por ejemplo `empresa--backend`.

## Uso en una tarea

1. Crea una tarea o elige un worktree existente.
2. Abre su menú `⋯` y selecciona **Devcontainer**.
3. Revisa la vista previa. Bento indica qué archivos creará, sobrescribirá u
   omitirá y pide confirmación para sobrescribir archivos existentes o versionados.
4. Si el proyecto tiene varios `.devcontainer`, elige cuál quieres preparar.
5. Pulsa **Aplicar y preparar devcontainer** y después **Abrir en editor**.
6. En VS Code ejecuta **Dev Containers: Reopen in Container**.

El ajuste del directorio raíz es global. Cada panel Tareas conserva por separado
el repositorio principal seleccionado y Bento calcula automáticamente qué receta
le corresponde.

## Seguridad y diagnóstico

- Los enlaces simbólicos dentro de una receta se rechazan para evitar copiar
  archivos fuera del directorio esperado.
- Los archivos versionados no se sobrescriben sin una segunda confirmación. Si
  se aceptan, Bento los marca como `skip-worktree` en ese worktree.
- Los errores de copia y de auto-wiring se muestran en el resultado.
- Bento avisa si el override no contiene `services:` o si el postcreate no tiene
  permiso de ejecución.
- La última aplicación queda registrada junto al `.env` del devcontainer y se
  vuelve a mostrar al abrir la tarea.

## Versionar las recetas

Los ajustes del panel incluyen acciones para inicializar Git, consultar el estado,
hacer commit, pull y push del directorio raíz de recetas. El remoto se configura
con Git de la forma habitual después de inicializarlo:

```bash
cd ~/bento-recipes
git remote add origin <url-del-repositorio>
git push -u origin main
```
