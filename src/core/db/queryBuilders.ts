export interface ForeignKey {
  table: string
  column: string
  ref_table: string
  ref_column: string
}

/** Las relaciones agrupadas por tabla de origen, para pintar un chip por tabla. */
export function groupRelations(relations: ForeignKey[]): Map<string, ForeignKey[]> {
  const byTable = new Map<string, ForeignKey[]>()
  relations.forEach(foreignKey => {
    byTable.set(foreignKey.table, [...(byTable.get(foreignKey.table) ?? []), foreignKey])
  })
  return byTable
}
