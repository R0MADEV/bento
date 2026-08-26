import { invoke } from '@tauri-apps/api/core'
import type { ChecksReport } from '../../generated/bindings/ChecksReport'
import type { PrCheck } from '../../generated/bindings/PrCheck'

// Qué cuenta como fallo o como pendiente vive en Rust (`bento_review::pr`),
// compartido con el TUI y el daemon: había tres criterios distintos y el mismo
// PR se veía de tres maneras.

export type { ChecksReport }

/** Lo que este criterio lee de un check; el resto del payload de GitHub sobra. */
export type PrCheckSignals = Partial<Pick<PrCheck, 'conclusion' | 'state' | 'status'>>

export const prCheckReport = (checks: PrCheckSignals[]): Promise<ChecksReport> =>
  invoke<ChecksReport>('gh_pr_check_report', { checks })
