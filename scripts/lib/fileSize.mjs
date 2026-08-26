// Un fichero grande no se detecta solo: crece un poco en cada cambio y nadie
// lo nota. Esto lo mide y solo deja pasar lo que ya estaba (y solo si no
// engorda), para que la deuda existente no bloquee mientras se paga.

const COMMENT = /^\s*(\/\/|\/\*|\*|#\s|--)/

// Las líneas que cuentan: sin blancos, sin comentarios, y en Rust sin el
// módulo de tests inline, que va en el mismo fichero por convención.
export function implementationLines(path, source) {
  const lines = source.split('\n')
  const end = path.endsWith('.rs')
    ? lines.findIndex(l => l.trim().startsWith('#[cfg(test)]'))
    : -1
  return lines
    .slice(0, end === -1 ? lines.length : end)
    .filter(l => l.trim() !== '' && !COMMENT.test(l))
    .length
}

// `baseline` mapea ruta -> tamaño tolerado. Devuelve solo lo que hay que
// arreglar: ficheros nuevos por encima del presupuesto, o conocidos que crecen.
export function overBudget(files, baseline, budget) {
  return files.flatMap(({ path, lines }) => {
    const allowed = baseline[path] ?? 0
    if (lines <= budget && !allowed) return []
    if (allowed && lines <= allowed) return []
    return [{ path, lines, allowed, reason: allowed ? 'ha crecido' : 'nuevo' }]
  })
}
