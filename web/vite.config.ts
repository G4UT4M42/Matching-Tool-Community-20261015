import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  // Google Drive can lock node_modules/.vite while syncing this workspace.
  // Keep Vite's disposable cache outside the synced project tree.
  cacheDir: path.join(process.env.LOCALAPPDATA ?? '.vite-cache', 'matching-tool-v2', 'vite'),
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
