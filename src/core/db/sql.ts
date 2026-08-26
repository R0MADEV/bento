import { invoke } from '@tauri-apps/api/core'
import type { DbServer } from './dbServer'
import type { ForeignKey } from './queryBuilders'

// Construir SQL vive en Rust (`bento_db::query`), compartido con quien lo
// necesite después: entrecomillar un nombre o escapar un literal es lo último
// que conviene tener escrito dos veces, una por lenguaje.

export interface PreparedQuery {
  /** La sentencia final, ya con el prefijo o las comillas que pida el motor. */
  sql: string
  /** La consulta sin punto y coma final, para paginar a partir de ella. */
  base: string
  /** Si el LIMIT lo puso Bento: entonces se puede ofrecer "cargar más". */
  limited: boolean
}

export const exampleQuery = (s: DbServer, name: string): Promise<string> =>
  invoke<string>('db_sql_example', { kind: s.kind, name })

export const relationQuery = (s: DbServer, table: string, foreignKeys: ForeignKey[]): Promise<string> =>
  invoke<string>('db_sql_relations', { kind: s.kind, table, foreignKeys })

/** `null` cuando esas tablas no están conectadas por sus relaciones. */
export const joinQuery = (s: DbServer, tables: string[], relations: ForeignKey[]): Promise<string | null> =>
  invoke<string | null>('db_sql_join', { kind: s.kind, tables, relations })

export const insertStatement = (
  s: DbServer, db: string, table: string, values: Array<[string, string | null]>,
): Promise<string> => invoke<string>('db_sql_insert', { kind: s.kind, db, table, values })

export const setNullStatement = (
  s: DbServer, db: string, table: string, column: string, wheres: Array<[string, string]>,
): Promise<string> => invoke<string>('db_sql_set_null', { kind: s.kind, db, table, column, wheres })

/** Le pone al SELECT su LIMIT de seguridad y lo adapta al motor. */
export const prepareQuery = (s: DbServer, sql: string, names: string[]): Promise<PreparedQuery> =>
  invoke<PreparedQuery>('db_sql_prepare', { kind: s.kind, sql, names })
