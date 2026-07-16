import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import '@fontsource-variable/bricolage-grotesque';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './index.css';

import { App } from './App.tsx';
import { SSEProvider } from './lib/sse.tsx';
import { applyTheme, resolveTheme } from './lib/theme.ts';

// Aplicar el tema antes del primer render evita el flash de tema claro.
applyTheme(resolveTheme());

// stale-while-revalidate en toda la app (principio #2): se muestra lo cacheado
// al instante y se refresca en background. Navegar entre pantallas no bloquea.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SSEProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </SSEProvider>
    </QueryClientProvider>
  </StrictMode>
);
