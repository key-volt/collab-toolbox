import { defineConfig } from 'vite'

// The sandbox page is built on its own, with no shared chunks: it runs at an opaque
// origin, so everything it loads must come from /sandbox/ paths that carry the
// cross-origin header, and nothing of the application may leak into its bundle.
export default defineConfig({
  root: 'sandbox',
  base: '/sandbox/',
  build: {
    outDir: '../dist-sandbox',
    emptyOutDir: true,
    sourcemap: false,
  },
})
