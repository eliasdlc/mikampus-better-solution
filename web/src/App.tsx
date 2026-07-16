import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout.tsx';
import { Dashboard } from './routes/Dashboard.tsx';
import { Buscar } from './routes/Buscar.tsx';
import { Inscripcion } from './routes/Inscripcion.tsx';

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/buscar" element={<Buscar />} />
        <Route path="/inscripcion" element={<Inscripcion />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
