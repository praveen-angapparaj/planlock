import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  // Keep documented configuration in the repository root even when Vite runs
  // from the client workspace through npm workspaces.
  envDir: '..',
  cacheDir: '../.vite',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: true } }
  }
});
