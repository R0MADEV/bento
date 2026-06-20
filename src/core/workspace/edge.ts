// Moving a panel "to the edge" of the layout = pick the group whose side is
// furthest in that direction. Pure logic so it can be tested without the DOM or
// Dockview.

export type MoveDirection = 'left' | 'right' | 'above' | 'below'

export interface Edges {
  left: number
  right: number
  top: number
  bottom: number
}

// "Towards the edge" value: the larger it is, the closer to the requested edge.
// For left/top the edge is at smaller values → flip the sign.
export function edgeValue(e: Edges, direction: MoveDirection): number {
  if (direction === 'right') return e.right
  if (direction === 'left') return -e.left
  if (direction === 'above') return -e.top
  return e.bottom
}

// Index of the group at the requested edge; -1 when there are no groups.
export function furthestEdgeIndex(groups: Edges[], direction: MoveDirection): number {
  if (groups.length === 0) return -1
  let best = 0
  for (let i = 1; i < groups.length; i++) {
    const isFurther = edgeValue(groups[i], direction) > edgeValue(groups[best], direction)
    if (isFurther) best = i
  }
  return best
}
