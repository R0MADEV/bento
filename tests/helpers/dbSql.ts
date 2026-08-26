import { expect } from 'vitest'

// El SQL lo construye Rust (`bento_db::query`, con sus propios tests): estos
// dobles solo devuelven algo reconocible para poder comprobar que el panel pide
// la sentencia correcta y manda tal cual la que le devuelven.
export const SQL_BUILD_COMMANDS = [
  'db_sql_example',
  'db_sql_relations',
  'db_sql_join',
  'db_sql_insert',
  'db_sql_set_null',
  'db_sql_prepare',
]

export const builtSql = (cmd: string): string => `SQL(${cmd})`

export interface FakeDbSqlOptions {
  /** Qué devuelve `db_sql_join`: `null` imita tablas sin relación entre ellas. */
  join?: string | null
}

/** El doble de un comando `db_sql_*`, o `undefined` si no lo es. */
export function fakeDbSql(
  cmd: string,
  args?: Record<string, unknown>,
  options: FakeDbSqlOptions = {},
): unknown | undefined {
  if (!SQL_BUILD_COMMANDS.includes(cmd)) return undefined
  if (cmd === 'db_sql_join') return options.join === undefined ? builtSql(cmd) : options.join
  if (cmd !== 'db_sql_prepare') return builtSql(cmd)
  const sql = String(args?.sql ?? '')
  const base = sql.trim().replace(/;\s*$/, '')
  return {
    sql: `PREPARED ${base}`,
    base,
    // Solo hace falta distinguir el caso que cambia lo que hace el panel:
    // sin LIMIT propio, ofrece paginar.
    limited: /^(select|with)\b/i.test(base) && !/\blimit\b\s+\d/i.test(base),
  }
}

/** Comprueba que se pidió esa sentencia con esos argumentos. */
export function expectSqlBuilt(
  invoke: { mock: { calls: unknown[][] } },
  cmd: string,
  args: Record<string, unknown>,
): void {
  const calls = invoke.mock.calls.filter(([name]) => name === cmd).map(([, sent]) => sent)
  expect(calls, `no se pidió ${cmd}`).not.toHaveLength(0)
  expect(calls).toContainEqual(expect.objectContaining(args))
}
