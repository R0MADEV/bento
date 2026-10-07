const DEFAULT_NAME = /^Agent (\d+)$/

export const isDefaultAgentName = (name: string): boolean => DEFAULT_NAME.test(name)

// The default name for a new agent: the lowest number no open agent is using,
// so closing "Agent 20" frees the 20 instead of the count growing forever.
export function nextAgentName(openNames: string[]): string {
  const taken = new Set(openNames.map(name => Number(DEFAULT_NAME.exec(name)?.[1])))
  let number = 1
  while (taken.has(number)) number++
  return `Agent ${number}`
}
