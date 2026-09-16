import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER = process.env.GAME_SERVER ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/ws': { target: SERVER.replace('http', 'ws'), ws: true },
      '/api': { target: SERVER, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'], react: ['react', 'react-dom'] },
      },
    },
  },
  worker: { format: 'es' },
});
