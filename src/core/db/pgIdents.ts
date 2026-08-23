/**
 * Postgres safety net: quotes known table names with uppercase letters if they
 * come unquoted (Postgres would lowercase them and fail). Covers what the AI
 * forgets to quote.
 */
export const pgFixIdents = (sql: string, names: string[]): string => {
  let out = sql
  const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  names.forEach(full => {
    if (!full.includes('.')) return
    const quotedRight = full.split('.').map(p => `"${p}"`).join('.')
    // Wrongly quoted as a single piece: "schema.table" → "schema"."table".
    out = out.split(`"${full}"`).join(quotedRight)
  })
  names.forEach(full => {
    const table = full.includes('.') ? full.split('.').slice(-1)[0] : full
    if (!/[A-Z]/.test(table)) return // the rest is only at risk due to uppercase letters
    const quotedFull = full.split('.').map(p => `"${p}"`).join('.')
    out = out.replace(new RegExp(`(^|[^"\\w.])${esc(full)}(?![\\w"])`, 'g'), `$1${quotedFull}`)
    out = out.replace(new RegExp(`(^|[^"\\w.])${esc(table)}(?![\\w"])`, 'g'), `$1"${table}"`)
  })
  return out
}
