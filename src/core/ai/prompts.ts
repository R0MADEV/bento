// Slash commands: shortcuts that expand `/command text` into a fuller prompt.
// Pure logic → testable. The UI just offers them and expands on send.

export interface SlashCommand {
  name: string
  label: string
  expand: (arg: string) => string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'explica', label: 'Explica', expand: a => `Explica de forma clara y concisa:\n\n${a}` },
  { name: 'traducir', label: 'Traducir a inglés', expand: a => `Traduce al inglés (devuelve solo la traducción):\n\n${a}` },
  { name: 'resume', label: 'Resumir', expand: a => `Resume en pocas líneas:\n\n${a}` },
  { name: 'corrige', label: 'Corregir', expand: a => `Corrige gramática y estilo; devuelve solo el texto corregido:\n\n${a}` },
]

// If the text starts with a known `/command`, expands it; otherwise leaves it as-is.
export function expandInput(text: string): string {
  const match = text.match(/^\/(\w+)\s*([\s\S]*)$/)
  if (!match) return text
  const command = SLASH_COMMANDS.find(c => c.name === match[1])
  return command ? command.expand(match[2].trim()) : text
}
