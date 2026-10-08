import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.dirname(fileURLToPath(import.meta.url));
const API_TARGET = process.env.API_TARGET || 'http://localhost:3001';

export default defineConfig({
  root,
  base: '/staff/',
  // staff-app has its own hoisted copy of vite, so @vitejs/plugin-react's `vite`
  // types are a structurally identical but nominally different Plugin type.
  plugins: [react()] as PluginOption[],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: process.env.PORT ? Number(process.env.PORT) : 5174,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/tts': {
        target: API_TARGET,
        changeOrigin: true,
      },
      // Without this the item photos 404 in dev while working in production,
      // which is exactly the kind of difference that hides a real bug until
      // after deployment.
      '/item-images': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});