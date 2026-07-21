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
  },
})

