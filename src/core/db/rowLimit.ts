// Añade un LIMIT de seguridad a un SELECT que no lo tenga. Sin cota, un JOIN
// ancho (SELECT * sobre muchas tablas) hace que el motor materialice un
// resultado enorme: revienta la RAM de la máquina y con ella el WebView.
// Es un navegador de BDs de desarrollo, no una herramienta de reporting, así
// que acotar por defecto es lo correcto.

export function withRowLimit(sql: string, limit = 200): string {
  const trimmed = sql.trim().replace(/;\s*$/, '')
  const isSelect = /^(select|with)\b/i.test(trimmed)
  const hasLimit = /\blimit\b\s+\d/i.test(trimmed)
  if (!isSelect || hasLimit) return sql
  return `${trimmed}\nLIMIT ${limit}`
}
