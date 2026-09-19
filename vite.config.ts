import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// `npm run dev` starts its fixture backend on a free port and names it here.
const api = `http://127.0.0.1:${process.env.DISPATCH_DEV_API_PORT ?? '5180'}`;
export default defineConfig({
  root: 'dashboard',
  base: './',
  plugins: [react()],
  build: { outDir: '../.build/dashboard', emptyOutDir: true, sourcemap: false },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: api, changeOrigin: false } },
  },
});
