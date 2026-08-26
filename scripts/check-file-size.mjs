// Comprueba que ningún fichero pase de 400 líneas de implementación. La deuda
// que ya existe está en file-size-baseline.json: no bloquea, pero tampoco
// puede crecer. Al partir uno, baja su número en el baseline (o bórralo).
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { implementationLines, overBudget } from './lib/fileSize.mjs'

const BUDGET = 400
const ROOTS = ['src', 'src-tauri/src', 'daemon/bento-cli/src', 'daemon/bento-core/src', 'daemon/bento-daemon/src', 'daemon/bento-review/src', 'scripts/lib']
const EXTENSIONS = ['.ts', '.rs', '.mjs', '.js']
const BASELINE = 'scripts/file-size-baseline.json'

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : walk(path)
    return EXTENSIONS.some(ext => entry.name.endsWith(ext)) ? [path] : []
  })
}

const files = ROOTS.filter(root => { try { return statSync(root).isDirectory() } catch { return false } })
  .flatMap(walk)
  .map(path => ({ path: relative('.', path), lines: implementationLines(path, readFileSync(path, 'utf8')) }))

if (process.argv.includes('--update-baseline')) {
  const baseline = Object.fromEntries(files.filter(f => f.lines > BUDGET).sort((a, b) => b.lines - a.lines).map(f => [f.path, f.lines]))
  writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`)
  console.log(`baseline actualizado: ${Object.keys(baseline).length} ficheros por encima de ${BUDGET}`)
  process.exit(0)
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
const offenders = overBudget(files, baseline, BUDGET)
if (!offenders.length) {
  const pending = Object.keys(baseline).length
  console.log(`file-size ok — ${files.length} ficheros, ${pending} con deuda anotada (máx. ${BUDGET} líneas)`)
  process.exit(0)
}
for (const { path, lines, allowed, reason } of offenders) {
  console.error(`${path}: ${lines} líneas de implementación (${reason}${allowed ? `, tolerado ${allowed}` : `, máximo ${BUDGET}`})`)
}
console.error('\nPártelo, o si es deliberado: node scripts/check-file-size.mjs --update-baseline')
process.exit(1)
