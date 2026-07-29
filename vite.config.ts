import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'esnext',
    minify: 'esbuild',
  },
  server: {
    host: '0.0.0.0',
    port: 5280,
    strictPort: true,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['src/core/**/*.ts'],
      thresholds: { lines: 85, functions: 80, statements: 85, branches: 75 },
    },
  },
})
