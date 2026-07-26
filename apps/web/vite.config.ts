import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        /**
         * Everything shipped as one chunk before this, so the landing page
         * paid for Monaco and xterm. These are the heavy, self-contained
         * dependencies worth isolating; anything not matched here keeps
         * Rollup's default chunking.
         */
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return;

          if (id.includes('monaco-editor') || id.includes('@monaco-editor')) {
            return 'monaco';
          }
          if (id.includes('xterm')) {
            return 'xterm';
          }
          if (id.includes('framer-motion')) {
            return 'framer-motion';
          }
          if (id.includes('react-router')) {
            return 'react-router';
          }

          return undefined;
        },
      },
    },
    // Monaco alone is legitimately large; the default 500 kB warning is noise
    // now that it is deliberately isolated in its own lazily fetched chunk.
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
