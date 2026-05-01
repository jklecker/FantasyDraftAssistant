import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
  ],
  server: {
    port: 3000,
    proxy: {
      '/draft':   { target: 'http://localhost:8080', changeOrigin: true },
      '/players': { target: 'http://localhost:8080', changeOrigin: true },
      '/ping':    { target: 'http://localhost:8080', changeOrigin: true },
      '/nfl':     { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  build: {
    outDir: 'build',
    sourcemap: false,
  },
  // CRA compatibility: map process.env.REACT_APP_API_BASE
  define: {
    'process.env.REACT_APP_API_BASE': JSON.stringify(process.env.VITE_API_BASE || ''),
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.js'],
  },
});

