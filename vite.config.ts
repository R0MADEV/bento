import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'esnext',
    minify: 'terser',
  },
  server: {
    host: '0.0.0.0',
    port: 8080,
  },
})
