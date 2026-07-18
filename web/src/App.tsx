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

export function App() {
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
