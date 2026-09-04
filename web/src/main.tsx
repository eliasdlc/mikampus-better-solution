import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import '@fontsource-variable/bricolage-grotesque';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
// El 700 existe por la hoja que se lleva a la oficina: toda ella usa font-bold
// y sin la fuente real el navegador sintetiza el trazo, justo en la columna del
// NRC, que es el número que la secretaria teclea.
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import './index.css';

import { App } from './App.tsx';
import { SSEProvider } from './lib/sse.tsx';
import { applyTheme, resolveTheme } from './lib/theme.ts';
import { AuthProvider } from './lib/auth.tsx';

// Aplicar el tema antes del primer render evita el flash de tema claro.
applyTheme(resolveTheme());

// El service worker (shell offline, requisito para instalar la PWA) solo existe
// en contexto seguro: localhost lo es, http://192.168.x.x NO. Abierta desde el
// teléfono por la LAN, mikampus es una web normal — funciona igual, pero el
// navegador no va a ofrecer instalarla. Registrar sin este guard es un error en
// consola en cada carga desde el teléfono.
if ('serviceWorker' in navigator && window.isSecureContext && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[pwa] no se pudo registrar el service worker:', err.message);
    });
  });
}

// stale-while-revalidate en toda la app (principio #2): se muestra lo cacheado
// al instante y se refresca en background. Navegar entre pantallas no bloquea.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <SSEProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </SSEProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>
);
