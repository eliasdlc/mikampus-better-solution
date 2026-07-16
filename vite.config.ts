import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// La SPA vive en web/ y se compila a public/dist, que sirve el mismo Express
// (npm start). En dev, `npm run dev` levanta Vite con proxy de /api al backend.
export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../public/dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4173',
    },
  },
});
