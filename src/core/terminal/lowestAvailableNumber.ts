export function lowestAvailableNumber(used: number[]): number {
  const taken = new Set(used)
  let n = 1
  while (taken.has(n)) n++
  return n
}
