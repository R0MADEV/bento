# Lo que queda pendiente

Estado a 1 de septiembre de 2026. Aquí va lo que estaba abierto y por qué
importaba. Lo que se decidió no hacer está al final, para no volver a
discutirlo.

Los puntos resueltos se conservan con lo que se hizo en cada uno, porque el
*por qué* sigue siendo útil para quien toque esa zona. Los tres primeros vienen
de `feat/cli-raw-attach` (PR #17); el 5 y el 6, del repaso de la review
compartida. Lo que sigue abierto está más abajo, en su propia sección.

## 1. Los resúmenes de sesión pierden datos — resuelto

**Qué pasaba.** El hook de fin de sesión guardaba la transcripción, creaba un
trabajo de resumen y lo procesaba en la misma ejecución. Si esa ejecución
fallaba, el trabajo se quedaba como estaba y nadie lo volvía a intentar. La
cola llegó a tener 87 `pending` (6–23 de agosto) y 2 `processing` a medias:
transcripciones guardadas sin resumen, con la memoria de esas sesiones perdida
salvo que algo las recogiera.

Eran los cuelgues que arregló `317a9fa` (el resumidor no respondía a SIGTERM,
la promesa no resolvía y el vigía mataba el proceso a los 300 s a medio
hacer): ese arreglo evitó que se siguieran acumulando, pero no vaciaba la cola
ya acumulada.

**Qué se hizo.** El propio hook, al empezar a procesar el resumen de la sesión
que lo disparó, primero drena un lote pequeño (3 por defecto) de trabajos
`pending`/`processing` con más de `BENTO_MEMORY_STALE_AFTER_MS` (10 min por
defecto — por encima del timeout de seguridad del hook) sin avanzar, y por
debajo de `BENTO_MEMORY_STALE_MAX_ATTEMPTS` (5 por defecto) reintentos. Se
autolimita para no alargar el cierre de la sesión actual ni reintentar para
siempre un trabajo que nunca va a poder resumirse; la cola se vacía sola,
sesión a sesión. `BENTO_MEMORY_SKIP_STALE_RETRY=1` lo desactiva.

La lógica de "generar resumen → completar/saltar/fallar el trabajo" se
compartía entre el flujo normal y este barrido, así que se extrajo a
`scripts/lib/summaryJobResolver.mjs` (`resolveSummaryJob`) para no
duplicarla; el barrido en sí vive en `scripts/lib/staleSummaryJobs.mjs`
(`sweepStaleSummaryJobs`), y la consulta SQL en
`selectStaleSummaryJobsSql` (`scripts/lib/memoryStore.mjs`).

## 2. El error de un resumen fallido no dice nada — resuelto

**Qué pasaba.** Los 38 `failed` tenían todos el mismo texto:

> El resumidor no devolvió un resultado válido.

Ese mensaje no distinguía entre el agente sin instalar, la sesión sin iniciar
y una respuesta que llegó pero no servía. La salida real del agente estaba
ahí y se tiraba.

**Qué se hizo.** Ahora se guarda la salida real del agente en la columna
`error` (`updateSummaryJobSql` ya la recorta a 2000 caracteres), y solo cuando
no devolvió nada en absoluto se usa un mensaje propio y distinto: *El
resumidor no devolvió ningún texto*. Así el `error` de un trabajo fallido
distingue por sí solo entre sesión sin iniciar y agente mudo, sin tener que
reproducirlo.

Se aplicó en los dos caminos que resuelven un trabajo, que hasta ahora
repetían el mismo mensaje genérico por separado: el del hook
(`resolveSummaryJob`, en `scripts/lib/summaryJobResolver.mjs`) y el del botón
de reintento del panel (`memory_regenerate_summary`, en Rust, donde la
decisión se extrajo a `classify_summary` para poder testearla aparte).

## 3. Verificar que el DMG vuelve a empaquetarse — verificado

`tauri build` fallaba en `bundle_dmg.sh`. No era el código: la `.app` se
construía bien y el fallo era solo el empaquetado. `bundle_dmg.sh` monta su
imagen temporal en `/Volumes/<nombre>` y fallaba porque ese nombre ya estaba
ocupado por montajes huérfanos de intentos anteriores.

Los volúmenes se limpiaron el 26 de agosto y el build completo se relanzó ese
mismo día: `bundle_dmg.sh` corrió sin fallar y dejó
`bundle/dmg/bento_0.0.1_aarch64.dmg` (8,6 MB), sin montajes huérfanos ni
`rw.*.dmg` residuales. Si vuelve a fallar, la limpieza es:

```sh
hdiutil detach /Volumes/dmg.*        # montajes huérfanos del propio bundle
hdiutil detach /Volumes/bento        # un .dmg de Bento montado a mano
rm src-tauri/target/release/bundle/macos/rw.*.dmg
```

## 4. Doce cadenas sin traducir que no son texto

`audit-i18n` anota 12 cadenas en `scripts/i18n-baseline.json`. **Ninguna se
traduce**, y el motivo está también en el comentario de `scripts/audit-i18n.mjs`
para no volver a mirarlo:

| qué | por qué se queda |
|---|---|
| `Bento` | el nombre del producto |
| `NULL` (×3) | literal SQL: traducirlo rompe la celda |
| `all`, `commented` | valores de un filtro, no etiquetas |
| `origin/main` | una rama, no una frase |
| `├── .env` (×4) | un árbol de ficheros en ASCII |
| `Picture in Picture` | el nombre de la función del navegador |

## 5. El repaso de la review — resuelto

Ocho arreglos y un hueco de tests, en orden. Todos venían de la misma mudanza:
la review pasó a correr en el daemon, compartida por escritorio, CLI y móvil, y
cada cliente se quedó con medio cable suelto.

**Los informes llegaban todos al final.** El motor esperaba a que terminaran
todos los agentes antes de emitir ninguno. Ahora sale cada uno en cuanto está,
en orden, mientras el siguiente sigue trabajando.

**Parar colgaba el panel y dejaba un worktree.** `emit("done")` vivía dentro de
la tarea que la cancelación abortaba, así que al parar no salía nunca. Ahora
`done` se emite desde fuera, esperando a esa tarea: sale como acabe la review,
cancelada incluida.

**El escritorio guardaba reviews que no podía reabrir.** El `run_id` se añadió
al guardado y no a la lectura, así que la reapertura miraba una ruta donde ya no
escribía nadie. Y el borrado, igual: la entrada volvía en el siguiente listado.

**Dos worktrees por review.** El panel preparaba el suyo, lo fotografiaba antes
y después y lo borraba al salir — pero al motor le pasaba el repo, y el motor
prepara el suyo. Nadie entraba en el del panel, así que el aviso de "el repo
cambió durante la review" no podía saltar. Fuera; el sha sale de `git_rev_parse`.

**El motivo real del fallo se tiraba.** El agente decía por qué (no instalado,
timeout, no contestó); el recolector lo cambiaba por "no encontrado o falló" y
el panel por "No valid review responses". Ahora llega el motivo, y los timeouts
y los fallos deterministas ya no se reintentan tres veces para nada.

**Las reviews de un cliente eran invisibles en el otro.** El escritorio archiva
la review de `feat/x` bajo `feat/x`; la TUI y el móvil bajo la base, con
`feat/x` en `branch`. La búsqueda solo miraba la clave. Ahora una review es de
la rama bajo la que está archivada y de la que nombra; y el daemon estampa rama
y commit al guardar, que los clientes sin git no los mandaban.

**El historial de la TUI, con el componente equivocado.** Se pintaba con el rail
izquierdo: chevron a la derecha, apuntando al revés, y el clic comprobándose
contra el borde izquierdo del cajón. Las filas no respondían al ratón. Ahora
comparte marco con el cajón, se clica, y la copia que vivía en el rail — cuyo
Enter ignoraba el `run_id` — ya no está.

**El informe del escritorio tapaba el diff.** Era un overlay `position:
absolute` sobre el panel. Ahora es la tercera columna, al lado del código contra
el que se lee.

**El escritorio no llegaba a las reviews que guardaba.** Con el `run_id`, una
rama conserva todas; la TUI y el móvil tenían su lista y el escritorio solo
podía reabrir la más nueva, sin poder borrar ninguna — con los dos comandos
Rust que hacían falta ya escritos y sin llamante. Ahora la tercera columna
cambia entre el informe y el historial del proyecto (no de la rama, para que
salgan también las del móvil y el terminal).

**Los tests que faltaban.** El dispatch IPC `review.*`, los handlers HTTP de
checkpoints y el cliente del móvil no tenían ninguno. El del móvil no es un
módulo: se carga como lo carga el navegador (`tests/web/reviewClient.test.ts`),
y ese patrón sirve para el resto de `remote/web`.

## 6. La lógica compartida, hasta donde llega — resuelto

El motor, los prompts, el contexto de lexis, el diff, las ramas, los PRs y el
almacén de checkpoints son una sola implementación en `bento-review` que usan
el escritorio, el móvil y la CLI. Lo que no lo era:

**El documento de la review lo montaba cada uno.** `report::build_document`
existe para que los tres escriban el mismo markdown y solo lo llamaba el
escritorio: la TUI concatenaba trozos con sus propios títulos y el móvil se
quedaba con la síntesis pelada, tirando el informe de cada agente. Ahora lo
monta el motor y lo manda como un evento más (`[DOCUMENT]`, por el mismo
formato de siempre), acabe la review como acabe: si un agente falla, el fallo
entra en el documento como una sección suya y sale igual, que es justo cuando
más falta hace. `Done` sigue saliendo solo si terminó — anunciar un final que no
hubo era peor —, así que los clientes archivan al recibir el documento y no al
recibir el final. El escritorio sigue montando el suyo porque guarda checkpoint
tras cada etapa y necesita documento a mitad de review; recibe el evento igual
para que no acabe pegado al informe como texto. El `bento review` de una tirada
lo ignora: ese modo escribe a una tubería según llega.

Con las etapas partidas en dos funciones el motor se pasaba del presupuesto de
tamaño, así que la planificación (cuántas etapas, quién analiza, quién verifica)
vive en `plan.rs`.

**Los archivos vistos del escritorio vivían en el navegador.** La TUI y el móvil
los guardan en `bento_review::viewed`. Ahora los tres van al mismo sitio; lo que
hubiera en el navegador se mueve una vez y se borra de allí, para que desmarcar
un archivo no lo resucite.

**El commit guardado con cada review no lo miraba nadie.** Al reabrirla en el
escritorio se compara con el de la rama y se avisa si ya no coinciden. Y el
listado compartido marca cada entrada como desfasada o no, con un `rev-parse`
por rama y no por review, así que lo dicen los tres clientes igual.

**El escritorio no llegaba a las reviews que guardaba** (ver el punto 5) y
tenía dos comandos sin llamante de cuando orquestaba la review por su cuenta,
`review_lexis_context` y `review_validate_finding_path`. Fuera.

Lo que se queda repetido a propósito: el markdown se pinta en tres sitios
(`renderMarkdown` en TS, `mdToHtml` en el cliente web, texto plano en la TUI).
Son dos runtimes JS sin build compartido y una TUI que no pinta HTML.

---

## 7. Los comandos sin llamante — resuelto

Cuatro comandos escritos, registrados y sin nadie que los llamara. Ninguno era
funcionalidad a medias: eran la copia muerta de algo que ya funciona por otro
lado, así que se fueron.

`memory_source_import` montaba el bucle de importación entero en Rust mientras
el panel importa con el suyo, candidato a candidato para poder enseñar
progreso; la regla de qué se salta, qué se fusiona y qué se crea sí está
compartida (`memory_plan_import`), que es lo que piden las normas. Duplicado
estaba el bucle, no la regla.

`memory_transcript_list` y `memory_transcript_create` eran la versión Rust de lo
que el hook hace directo contra SQLite desde `scripts/lib/memoryStore.mjs`. Si
algún día el escritorio enseña esas transcripciones, es una pantalla nueva, no
estos comandos. `agent_socket_path` no aparecía en ningún sitio.

**Ojo con dos falsos positivos**: `workspace_reset` y los trece `db_docker_*`
parecen muertos y no lo están — el primero lo usa `scripts/e2e-tasks.mjs`, y los
otros se construyen a mano en `dbEngine.ts` (`db_docker_${engine}_${op}`).

## 8. La review y el terminal, iguales en los tres — resuelto

El objetivo era que la tech review y el terminal hicieran lo mismo desde el
escritorio, el móvil y la CLI. Idéntica no puede ser la interfaz —xterm.js en
dos, un emulador propio en ratatui en la otra—, así que lo que se persiguió fue
lo demás: las mismas capacidades, los mismos conceptos y los mismos nombres.

**Terminal.** Cerrar una terminal solo lo sabía hacer el escritorio y el móvil;
la TUI ahora también (`k`). Abrir eligiendo dónde: el móvil pregunta el proyecto
(los directorios donde ya hay terminales) y la TUI abre donde vive la que tienes
seleccionada, que es lo que ya está enseñando. La TUI no guardaba nada de lo que
salía de pantalla —scrollback cero— y ahora guarda 2000 líneas como los otros
dos, con ⇧RePág/⇧AvPág y aviso en la cabecera de que estás mirando atrás. Buscar
lo tenía solo el escritorio: el móvil carga el mismo addon de xterm y la TUI
busca sobre su buffer con F3.

**Review.** Comentar una línea del diff era solo del escritorio; ahora la TUI lo
hace con `c` sobre la línea marcada y el móvil de un toque sobre la fila. Los
ficheros vistos y el filtro por estado llegaron al móvil (el almacén ya existía;
faltaba el puerto HTTP). El aviso de que una review es de un commit que la rama
dejó atrás lo dan los tres, tanto en el listado como al abrirla.

**Los perfiles de terminal** vivían en el `localStorage` del escritorio, así que
fuera de esa ventana no existían: ahora están en `~/.bento/terminal-profiles.json`
(`bento_core::profiles`). El escritorio los crea y aplica desde el panel (⌘P) y
desde la paleta; el móvil pregunta con cuál abrir mandando **el id, no el shell**
—lo que se ejecuta sale de algo ya guardado, no de la red—; la TUI los recorre
con `p`.

Lo que se quedó fuera a propósito: tema y tamaño de letra en el móvil (el
escritorio es el único que pinta con ellos) y la vista partida, el árbol de
ficheros, copiar el diff y saltar entre comentarios, que son comodidades de una
GUI grande.

## Lo que sigue abierto

Nada bloqueante. `src/core` está al 97,6 % de líneas con el umbral en 85, y el
cliente web del móvil tiene tests en sus cuatro ficheros.

`createTerminalAppearanceControls` (el popover de tema, shell y fuente del
terminal) sigue escrito, probado y sin montar en ningún panel — el mismo caso
que tenían los perfiles antes de este trabajo. O se monta o se borra.

## Decidido que no

No son deuda: se miraron y se descartaron con motivo.

| qué | por qué |
|---|---|
| Vault, Jira, HTTP y Web fuera del escritorio | Política de `remote-exposure.md`. El HTTP con URL libre, además, sería un proxy SSRF. |
| Paneles TV, Scripts y Móvil a una crate | No tienen un segundo consumidor. Sería mudanza por mudanza. |
| `parseDiffFiles` y `fileStateMap` a Rust | Parsean un diff que el panel ya tiene en memoria para pintarlo. Cruzarían el IPC devolviendo los mismos megabytes recortados, y el motor de review ya tiene su propio `split_diff_into_file_diffs`. |
| `previewRebase`, `reorderByDrop`, `mapWithConcurrency` | Utilidades de interfaz, aunque vivan en `core/`. |
| La orquestación de la review del escritorio | Va cosida al DOM del progreso y al botón de parar. El daemon usa `bento_review::engine` para lo suyo. |

**El criterio, por si aparece un caso nuevo:** cruza a Rust lo que tenga un
segundo consumidor real (CLI, daemon o móvil), o lo que sea una regla escrita
dos veces. Lógica pura no es motivo suficiente.

## Cosas que muerden y no se ven

Aprendidas a base de que pasaran:

- **Traducir un panel vuelve sus tests dependientes del idioma.** Los que buscan
  un botón por su texto empiezan a depender del orden de los ficheros, porque
  varios hacen `stubGlobal` del `localStorage` y eso se filtra entre ellos.
  `tests/setup.ts` fija el idioma antes de cada test; si aparece un fallo así,
  mirar ahí antes que al panel.
- **`npm run test:coverage` se queda sin memoria en local, no en CI.**
  `coverage.all` recorre el proyecto y se metía en `target/` — 80 GB de
  artefactos de cargo. Excluido en `vite.config.ts`; si se toca ese exclude,
  vuelve.
- **Un `git bisect` miente si el entorno cambia entre ramas.** El OOM de arriba
  señaló un commit inocente: el worktree de prueba no tenía `target/` y la
  carpeta de trabajo sí.
- **El cliente web del daemon se puede testear.** No es un módulo: se lee el
  fichero y se evalúa como lo evalúa el navegador, con `let` top-level cambiado
  a `var` para poder leer su estado desde el test. Está en
  `tests/web/reviewClient.test.ts`.
- **Escribirle a un hijo que ya se fue tumba el proceso.** El resumidor le pasa
  el prompt al agente por stdin; si el agente no está o cerró su entrada, ese
  `write` da EPIPE, y sin un `on('error')` no se cae el resumen sino el hook
  entero. Salió como un fallo intermitente de la suite completa que no se
  reproducía corriendo el fichero solo.
- **Un test que mueve `HOME` compite con los demás del mismo binario.** Los de
  perfiles pasaban sueltos y fallaban en la suite completa. El patrón del repo
  es que la función acepte la ruta (`list_in`, `save_in`, `viewed::get_in`) y el
  envoltorio la saque de `HOME`.
- **CI corre en Windows.** `process.kill(-pid)` (grupo de procesos) y los
  scripts `.sh` en tests no valen allí. El patrón del repo es una función pura
  que recibe la plataforma, como `crossPlatformProcess.mjs`.
