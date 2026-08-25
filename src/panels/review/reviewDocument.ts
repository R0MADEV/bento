import { invoke } from '@tauri-apps/api/core'
import type { ChangedFile } from '../../generated/bindings/ChangedFile'
import type { FollowUpSession } from '../../generated/bindings/FollowUpSession'
import type { OverviewInput } from '../../generated/bindings/OverviewInput'
import type { ReviewDocumentMeta } from '../../generated/bindings/ReviewDocumentMeta'
import type { MultiAgentReviewRun } from '../../core/ai/techReview'

// El formato de la review vive en Rust (`bento_review::report`), compartido con
// el daemon y el CLI. Estas funciones son la puerta de entrada del frontend;
// viven aquí, en el panel, y no en `core/`, que no habla con Tauri.

export type { ChangedFile, FollowUpSession, OverviewInput, ReviewDocumentMeta }

/// El markdown completo: cabecera más el informe de cada agente.
export function buildReviewDocument(meta: ReviewDocumentMeta, runs: MultiAgentReviewRun[]): Promise<string> {
  return invoke<string>('review_build_document', { meta, runs })
}

// Con qué sesión se sigue hablando: la del último agente que analizó de verdad.
export function resolveReviewFollowUpSession(runs: MultiAgentReviewRun[], count: number): Promise<FollowUpSession> {
  return invoke<FollowUpSession>('review_follow_up_session', { runs, count })
}

// Lo primero que lee el agente: de dónde sale el cambio y qué ficheros toca.
export function buildReviewOverview(input: OverviewInput): Promise<string> {
  return invoke<string>('review_build_overview', { input })
}

// Un fallo pasajero (límite de peticiones, red) merece un reintento; un timeout
// no. La lista está en Rust, que es donde la usan también el daemon y el CLI.
export function isRetryableReviewError(message: string): Promise<boolean> {
  return invoke<boolean>('review_is_retryable', { message })
}
