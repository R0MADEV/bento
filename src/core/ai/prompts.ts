// Slash commands: atajos que expanden `/comando texto` en un prompt más completo.
// Pura lógica → testeable. La UI solo los ofrece y expande al enviar.

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

// Si el texto empieza por `/comando` conocido, lo expande; si no, lo deja igual.
export function expandInput(text: string): string {
  const match = text.match(/^\/(\w+)\s*([\s\S]*)$/)
  if (!match) return text
  const command = SLASH_COMMANDS.find(c => c.name === match[1])
  return command ? command.expand(match[2].trim()) : text
}
