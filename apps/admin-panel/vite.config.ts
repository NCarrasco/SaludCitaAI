import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// El panel se sirve desde la API en /panel/ (mismo origen que /api/v1).
// En desarrollo, Vite reenvía /api a la API local para conservar el mismo origen y las cookies.
export default defineConfig({
  base: '/panel/',
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 700 },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8080' } },
});
