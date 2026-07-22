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
      '/api': {
        target: 'http://localhost:4173',
        changeOrigin: true,
        configure: (proxy) => {
          // El guard local compara Origin contra el agente. En desarrollo la
          // SPA vive en :5173, por lo que el proxy debe presentar el origen del
          // agente y no hacer que cada botón de onboarding falle con un 403.
          proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('origin', 'http://localhost:4173'));
        },
      },
    },
  },
});
