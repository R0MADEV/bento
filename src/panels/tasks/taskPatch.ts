import { invoke } from '@tauri-apps/api/core'
import type { FilePatch } from '../../generated/bindings/FilePatch'

// Armar el parche vive en Rust (`bento_review::diff`), al lado de quien lo
// aplica: los trozos van tal cual salen del `git diff` original, y por eso
// `git apply` se llama con `--unidiff-zero`. Tenerlo medio en cada lenguaje era
// pedir que se separaran.

/** El parche con los ficheros marcados enteros y, del resto, los trozos elegidos. */
export function buildSelectedPatch(
  diff: string,
  wholeFiles: ReadonlySet<string>,
  selectedHunks: ReadonlyMap<string, ReadonlySet<number>>,
): Promise<string> {
  return invoke<string>('git_build_patch', {
    diff,
    wholeFiles: [...wholeFiles],
    selectedHunks: Object.fromEntries([...selectedHunks].map(([file, hunks]) => [file, [...hunks]])),
  })
}

/** Un fichero del diff partido en cabecera y trozos, para pintarlo. */
export function parseFilePatch(chunk: string): Promise<FilePatch> {
  return invoke<FilePatch>('git_parse_file_patch', { chunk })
}
