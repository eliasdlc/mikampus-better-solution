import { Routes, Route, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Layout } from './components/Layout.tsx';
import { Dashboard } from './routes/Dashboard.tsx';
import { Horario } from './routes/Horario.tsx';
import { Inscripcion } from './routes/Inscripcion.tsx';
import { Academico } from './routes/Academico.tsx';
import { Trayectoria } from './routes/Trayectoria.tsx';
import { Ajustes } from './routes/Ajustes.tsx';
import { Landing } from './routes/Landing.tsx';
import { Login } from './routes/Login.tsx';
import { Docs } from './routes/Docs.tsx';
import { Onboarding } from './routes/Onboarding.tsx';
import { useAuth } from './lib/auth.tsx';
import { fetchOnboarding } from './lib/api.ts';
import { legacyPlanTarget } from './lib/legacyRoutes.ts';

// El mapeo vive en lib/legacyRoutes.ts para poder probarlo sin montar router.
function LegacyPlanRedirect() {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  return <Navigate to={legacyPlanTarget(pathname, params)} replace />;
}

export function App() {
  const { loading, authenticated } = useAuth();
  // El onboarding es lo primero que se resuelve, incluso antes del landing: sin
  // modo elegido ni browser instalado no hay nada que mikampus pueda hacer, y
  // mandarlo a una terminal sería fallar el objetivo de la fase.
  const onboarding = useQuery({ queryKey: ['onboarding'], queryFn: fetchOnboarding, enabled: !authenticated });
  const needsSetup =
    !authenticated && onboarding.data != null && ['mode', 'prerequisites', 'browser'].includes(onboarding.data.step);

  if (loading || (!authenticated && onboarding.isLoading)) {
    return <main className="text-muted flex min-h-full items-center justify-center text-sm">Abriendo mikampus…</main>;
  }

  if (needsSetup) {
    return (
      <Routes>
        <Route path="/docs" element={<Docs />} />
        <Route path="*" element={<Onboarding />} />
      </Routes>
    );
  }

  if (!authenticated) {
    return (
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/entrar" element={<Login />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  // /docs es pública y vive fuera del shell de la app: con sesión también se
  // lee a pantalla completa, sin el sidebar de navegación.
  return (
    <Routes>
      <Route path="/docs" element={<Docs />} />
      <Route
        path="*"
        element={
          <Layout>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              {/* Planear se fusionó dentro del workspace de Inscripción (P2).
                  Los redirects conservan el plan abierto y mandan a la etapa
                  equivalente: un bookmark viejo no puede caer en un 404. */}
              <Route path="/planear" element={<LegacyPlanRedirect />} />
              <Route path="/planner" element={<LegacyPlanRedirect />} />
              <Route path="/builder" element={<LegacyPlanRedirect />} />
              <Route path="/buscar" element={<Navigate to="/" replace />} />
              <Route path="/horario" element={<Horario />} />
              <Route path="/inscripcion" element={<Inscripcion />} />
              <Route path="/trayectoria" element={<Trayectoria />} />
              <Route path="/academico" element={<Academico />} />
              <Route path="/holds" element={<Navigate to="/" replace />} />
              <Route path="/ajustes" element={<Ajustes />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Layout>
        }
      />
    </Routes>
  );
}
