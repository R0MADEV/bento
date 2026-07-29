import js from '@eslint/js'
import tseslint from 'typescript-eslint'

const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
  HTMLElement: 'readonly', Element: 'readonly', Node: 'readonly', MutationObserver: 'readonly', CustomEvent: 'readonly', Event: 'readonly',
  KeyboardEvent: 'readonly', MouseEvent: 'readonly', ResizeObserver: 'readonly', Blob: 'readonly', URL: 'readonly', FileReader: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', alert: 'readonly', prompt: 'readonly', confirm: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', fetch: 'readonly', AbortSignal: 'readonly',
  console: 'readonly', crypto: 'readonly', getComputedStyle: 'readonly', WebSocket: 'readonly', HTMLInputElement: 'readonly', HTMLButtonElement: 'readonly',
}

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'src/generated/**', 'src-tauri/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { globals: browserGlobals },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['scripts/**/*.mjs', '*.config.js'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', fetch: 'readonly', AbortSignal: 'readonly' } },
  },
)
