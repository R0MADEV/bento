import { invoke } from '@tauri-apps/api/core'
import type { AppSettings, AppSettingsRepository } from '../ports/AppSettingsRepository'

export class TauriAppSettingsRepository implements AppSettingsRepository {
  async load(): Promise<AppSettings> {
    return invoke<AppSettings>('settings_get')
  }

  async save(settings: AppSettings): Promise<void> {
    await invoke('settings_set', { settings })
  }
}
