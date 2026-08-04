export interface AppSettings {
  devcontainerRecipesDir?: string
}

export interface AppSettingsRepository {
  load(): Promise<AppSettings>
  save(settings: AppSettings): Promise<void>
}
