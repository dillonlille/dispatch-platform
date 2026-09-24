import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Standalone Vite defaults; npm run dev supplies its own ports and session proxy.
const api = `http://127.0.0.1:${process.env.DISPATCH_DEV_API_PORT ?? '5180'}`;
export default defineConfig({
  root: 'dashboard',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../.build/dashboard',
    emptyOutDir: true,
    sourcemap: false,
    rolldownOptions: {
      treeshake: {
        // The table modules run nothing when imported. Saying so lets the unused table
        // code behind the shared `ui` index leave the entry chunk, as it did before
        // Rolldown; the routes that render tables load it with them.
        moduleSideEffects: [
          {
            test: /[\\/]dashboard[\\/]src[\\/]ui[\\/](useDataTable|tableCsv|DataTable)\.tsx?$/,
            sideEffects: false,
          },
        ],
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.DISPATCH_DEV_PORT || 0),
    strictPort: true,
    proxy: { '/api': { target: api, changeOrigin: false } },
  },
});
