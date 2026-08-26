# Lo que queda pendiente

Estado a 26 de agosto de 2026, con la rama `feat/cli-raw-attach` ya mergeada
(PR #17). Aquí va lo que estaba abierto y por qué importaba. Lo que se decidió
no hacer está al final, para no volver a discutirlo.

**Los tres puntos abiertos están cerrados**: se conservan con lo que se hizo
en cada uno, porque el *por qué* sigue siendo útil para quien toque esa zona.

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

---

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
- **CI corre en Windows.** `process.kill(-pid)` (grupo de procesos) y los
  scripts `.sh` en tests no valen allí. El patrón del repo es una función pura
  que recibe la plataforma, como `crossPlatformProcess.mjs`.
