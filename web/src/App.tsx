import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout.tsx';
import { Dashboard } from './routes/Dashboard.tsx';
import { Buscar } from './routes/Buscar.tsx';
import { Planner } from './routes/Planner.tsx';
import { Builder } from './routes/Builder.tsx';
import { Horario } from './routes/Horario.tsx';
import { Inscripcion } from './routes/Inscripcion.tsx';
import { Academico } from './routes/Academico.tsx';
import { Trayectoria } from './routes/Trayectoria.tsx';
import { Holds } from './routes/Holds.tsx';
import { Ajustes } from './routes/Ajustes.tsx';
import { Landing } from './routes/Landing.tsx';
import { Login } from './routes/Login.tsx';
import { useAuth } from './lib/auth.tsx';

export function App() {
  const { loading, authenticated } = useAuth();

  if (loading) {
    return <main className="text-muted flex min-h-full items-center justify-center text-sm">Abriendo mikampus…</main>;
  }

  if (!authenticated) {
    return (
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/entrar" element={<Login />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/buscar" element={<Buscar />} />
        <Route path="/planner" element={<Planner />} />
        <Route path="/builder" element={<Builder />} />
        <Route path="/horario" element={<Horario />} />
        <Route path="/inscripcion" element={<Inscripcion />} />
        <Route path="/trayectoria" element={<Trayectoria />} />
        <Route path="/academico" element={<Academico />} />
        <Route path="/holds" element={<Holds />} />
        <Route path="/ajustes" element={<Ajustes />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
