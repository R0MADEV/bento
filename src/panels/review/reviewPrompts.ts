import { invoke } from '@tauri-apps/api/core'
import type { ContextSource } from '../../core/ai/techReview'

// El texto del prompt vive en Rust (`daemon/bento-review`), compartido con el
// daemon y el CLI. Estas dos funciones son la puerta de entrada del frontend;
// viven aquí, en el panel, y no en `core/`, que no habla con Tauri.

export interface ReviewPromptInput {
  project: string
  base: string
  diff: string
  files: Array<{ path: string; content: string }>
  contextSources: ContextSource[]
  lexisContext?: string
  // Lo que el autor quiere que el revisor mire con lupa (opcional).
  authorContext?: string
}

export function buildReviewPrompt(input: ReviewPromptInput): Promise<string> {
  return invoke<string>('review_build_prompt', { input })
}

// Consolidación final: un agente lee los análisis de los demás y produce un
// único informe. Misma implementación compartida que el prompt de review.
export function buildReviewSynthesisPrompt(basePrompt: string, reports: Array<{ label: string; report: string }>): Promise<string> {
  return invoke<string>('review_build_synthesis_prompt', { basePrompt, reports })
}
