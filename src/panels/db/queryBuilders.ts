import type { DbServer } from '../../core/db/dbServer'
import type { JoinPlan } from '../../core/db/joinPath'

export interface ForeignKey {
  table: string
  column: string
  ref_table: string
  ref_column: string
}

const isMongo = (server: DbServer): boolean => server.kind === 'mongodb'
const isPg = (server: DbServer): boolean => server.kind === 'postgres'

/** Quote a table or column identifier for the active SQL engine. */
export function quoteIdentifier(server: DbServer, name: string): string {
  return isPg(server) ? name.split('.').map(part => `"${part}"`).join('.') : `\`${name}\``
}

export function exampleQuery(server: DbServer, name: string): string {
  if (isMongo(server)) return `db.${name}.find().limit(20).toArray()`
  if (server.kind === 'redis') return `GET ${name}`
  return `SELECT * FROM ${quoteIdentifier(server, name)} LIMIT 100`
}

export function buildRelationQuery(server: DbServer, table: string, foreignKeys: ForeignKey[]): string {
  if (isMongo(server)) {
    const stages = foreignKeys.map(foreignKey =>
      `  { $lookup: { from: "${foreignKey.ref_table}", localField: "${foreignKey.column}", foreignField: "_id", as: "${foreignKey.ref_table}" } }`)
    return `db.${table}.aggregate([\n${stages.join(',\n')},\n  { $limit: 20 }\n]).toArray()`
  }
  const joins = foreignKeys.map((foreignKey, index) => {
    const alias = `r${index + 1}`
    return `JOIN ${quoteIdentifier(server, foreignKey.ref_table)} ${alias} ON base.${quoteIdentifier(server, foreignKey.column)} = ${alias}.${quoteIdentifier(server, foreignKey.ref_column)}`
  })
  return `SELECT * FROM ${quoteIdentifier(server, table)} base\n${joins.join('\n')}\nLIMIT 100`
}

export function buildJoinQuery(server: DbServer, plan: JoinPlan): string {
  const aliases = new Map<string, string>([[plan.base, 't0']])
  let sql = `SELECT * FROM ${quoteIdentifier(server, plan.base)} t0`
  plan.steps.forEach((step, index) => {
    const alias = `t${index + 1}`
    aliases.set(step.to, alias)
    sql += `\nJOIN ${quoteIdentifier(server, step.to)} ${alias} ON ${aliases.get(step.from)}.${quoteIdentifier(server, step.fromCol)} = ${alias}.${quoteIdentifier(server, step.toCol)}`
  })
  return `${sql}\nLIMIT 100`
}

export function groupRelations(relations: ForeignKey[]): Map<string, ForeignKey[]> {
  const byTable = new Map<string, ForeignKey[]>()
  relations.forEach(foreignKey => {
    byTable.set(foreignKey.table, [...(byTable.get(foreignKey.table) ?? []), foreignKey])
  })
  return byTable
}
