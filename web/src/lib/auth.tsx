import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchAuthMe,
  login as portalLogin,
  logout as portalLogout,
  setCsrfToken,
  setUnauthorizedHandler,
  type AuthMe,
} from './api.ts';

type AuthContextValue = {
  me: AuthMe | null;
  loading: boolean;
  authenticated: boolean;
  // La sesión se cerró sola: el portal rechazó la credencial o el archivo
  // quedó vacío. La home lo dice una vez; volver a entrar lo limpia.
  sessionLost: boolean;
  login: (input: { username: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
};

const SIGNED_OUT: AuthMe = { mode: 'local', user: null, csrfToken: null };

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: ['auth-me'],
    queryFn: fetchAuthMe,
    retry: false,
    staleTime: Infinity,
  });
  const me = meQuery.data ?? null;
  setCsrfToken(me?.csrfToken ?? null);
  const [sessionLost, setSessionLost] = useState(false);

  // Salir es un solo cambio de estado: con `user: null` el router deja de
  // montar la plataforma y cualquier ruta cae en la home. Las queries
  // personales se descartan después, para que no vuelvan a pedirse sin sesión.
  const signOut = (lost: boolean) => {
    setCsrfToken(null);
    setSessionLost(lost);
    queryClient.setQueryData<AuthMe>(['auth-me'], SIGNED_OUT);
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth-me' });
  };

  useEffect(() => {
    setUnauthorizedHandler(() => signOut(true));
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = async (input: { username: string; password: string }) => {
    const result = await portalLogin(input);
    setCsrfToken(result.csrfToken);
    setSessionLost(false);
    queryClient.setQueryData<AuthMe>(['auth-me'], {
      mode: 'local',
      user: result.user,
      csrfToken: result.csrfToken,
    });
  };

  const logout = async () => {
    try {
      await portalLogout();
    } finally {
      signOut(false);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        me,
        loading: meQuery.isLoading,
        authenticated: me?.user != null,
        sessionLost,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return context;
}
