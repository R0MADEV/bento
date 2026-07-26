// Constructor de JOINs determinista: dado un conjunto de tablas y las relaciones
// (claves foráneas) de la BD, encuentra un árbol de JOINs que las conecte, usando
// tablas intermedias si hace falta. Pura lógica de grafo → testeable, sin IA.

export interface Relation {
  table: string
  column: string
  refTable: string
  refColumn: string
}

export interface JoinStep {
  from: string
  fromCol: string
  to: string
  toCol: string
}

export interface JoinPlan {
  base: string
  steps: JoinStep[]
}

interface Edge {
  a: string
  aCol: string
  b: string
  bCol: string
}

const edgeToStep = (edge: Edge, from: string, to: string): JoinStep =>
  from === edge.a
    ? { from, fromCol: edge.aCol, to, toCol: edge.bCol }
    : { from, fromCol: edge.bCol, to, toCol: edge.aCol }

// BFS multi-origen desde el conjunto conectado hasta `target`. Devuelve la secuencia
// de aristas (con dirección) que forma el camino más corto, o null si no hay.
function bfsPath(adj: Map<string, Edge[]>, connected: Set<string>, target: string): Array<{ edge: Edge; from: string; to: string }> | null {
  const queue: string[] = [...connected]
  const visited = new Set<string>(connected)
  const prev = new Map<string, { node: string; edge: Edge }>()

  while (queue.length) {
    const node = queue.shift() as string
    if (node === target) break
    for (const edge of adj.get(node) ?? []) {
      const next = edge.a === node ? edge.b : edge.a
      if (visited.has(next)) continue
      visited.add(next)
      prev.set(next, { node, edge })
      queue.push(next)
    }
  }

  if (!prev.has(target)) return null
  const seq: Array<{ edge: Edge; from: string; to: string }> = []
  let cur = target
  while (prev.has(cur)) {
    const { node, edge } = prev.get(cur) as { node: string; edge: Edge }
    seq.unshift({ edge, from: node, to: cur })
    cur = node
  }
  return seq
}

export function buildJoinPath(tables: string[], relations: Relation[]): JoinPlan | null {
  const targets = [...new Set(tables)].filter(Boolean)
  if (targets.length === 0) return null
  if (targets.length === 1) return { base: targets[0], steps: [] }

  const adj = new Map<string, Edge[]>()
  const link = (node: string, edge: Edge): void => {
    if (!adj.has(node)) adj.set(node, [])
    adj.get(node)!.push(edge)
  }
  relations.forEach(r => {
    const edge: Edge = { a: r.table, aCol: r.column, b: r.refTable, bCol: r.refColumn }
    link(edge.a, edge)
    link(edge.b, edge)
  })

  const base = targets[0]
  const connected = new Set<string>([base])
  const steps: JoinStep[] = []

  for (const target of targets.slice(1)) {
    if (connected.has(target)) continue
    const path = bfsPath(adj, connected, target)
    if (!path) return null
    for (const { edge, from, to } of path) {
      if (connected.has(to)) continue
      steps.push(edgeToStep(edge, from, to))
      connected.add(to)
    }
  }
  return { base, steps }
}
