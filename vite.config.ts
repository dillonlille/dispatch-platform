import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Standalone Vite defaults; npm run dev supplies its own ports and session proxy.
const api = `http://127.0.0.1:${process.env.DISPATCH_DEV_API_PORT ?? '5180'}`;
export default defineConfig({
  root: 'dashboard',
  base: './',
  plugins: [react()],
  build: { outDir: '../.build/dashboard', emptyOutDir: true, sourcemap: false },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.DISPATCH_DEV_PORT || 0),
    strictPort: true,
    proxy: { '/api': { target: api, changeOrigin: false } },
  },
});
