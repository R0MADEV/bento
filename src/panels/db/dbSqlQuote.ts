import type { DbServer } from '../../core/db/dbServer'
import { isPg } from './dbAccess'

/** Quotes a column or table name for the engine's own identifier syntax. */
export const ident = (s: DbServer, id: string): string => isPg(s) ? `"${id}"` : `\`${id}\``

/**
 * The table as the engine addresses it: MySQL qualifies with the database,
 * Postgres quotes each part on its own so the dot stays outside the quotes
 * ("schema"."table", never "schema.table").
 */
export const qualifiedTable = (s: DbServer, db: string, table: string): string =>
  isPg(s)
    ? table.split('.').map(p => `"${p}"`).join('.')
    : `\`${db}\`.\`${table}\``

/** Quotes a literal value: Postgres doubles quotes, MySQL escapes with backslashes. */
export const quoteValue = (s: DbServer, v: string): string =>
  isPg(s)
    ? `'${v.replace(/'/g, "''")}'`
    : `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
