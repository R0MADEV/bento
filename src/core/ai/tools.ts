// Una herramienta que el modelo puede invocar (function calling): el panel de
// BD ofrece get_columns para que pregunte las columnas de verdad en vez de
// inventárselas. Vive en core porque la define el dominio, no la interfaz.
export interface AiTool {
  name: string
  // Spec de OpenAI: { type: 'function', function: { name, description, parameters } }
  schema: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<string>
}
