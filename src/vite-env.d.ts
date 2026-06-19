/// <reference types="vite/client" />

declare module '*.m3u?raw' {
  const content: string
  export default content
}
