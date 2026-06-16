import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 3000,
    // NB: target is `127.0.0.1` (not `localhost`) on purpose. Node 18's DNS
    // resolver returns `::1` first for `localhost`, but the FastAPI dev server
    // is started with `--host 0.0.0.0` (IPv4-only). Node 18's http client has
    // no IPv4 fallback (happy-eyeballs landed in Node 20), so every proxied
    // `/api/*` call dies with ECONNREFUSED and Vite returns 500 text/plain.
    proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true, ws: true } },
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react':  ['react', 'react-dom', 'react-router-dom'],
          'vendor-charts': ['recharts'],
          'vendor-query':  ['@tanstack/react-query', 'axios'],
          'vendor-ui':     ['react-hot-toast', 'zustand', 'date-fns'],
        },
      },
    },
  },
})
