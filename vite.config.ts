import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'dashboard',
  base: './',
  plugins: [react()],
  build: { outDir: '../.build/dashboard', emptyOutDir: true, sourcemap: false },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:5180', changeOrigin: false } },
  },
});
