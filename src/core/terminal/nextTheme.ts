// Devuelve el siguiente tema en el ciclo (vuelve al primero al final).
export function nextTheme(current: string, names: string[]): string {
  const index = names.indexOf(current)
  return names[(index + 1) % names.length] ?? names[0]
}
