import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchAuthMe, login as portalLogin, logout as portalLogout, setCsrfToken, type AuthMe } from './api.ts';

type AuthContextValue = {
  me: AuthMe | null;
  loading: boolean;
  authenticated: boolean;
  login: (input: { username: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
};

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

  const login = async (input: { username: string; password: string }) => {
    const result = await portalLogin(input);
    setCsrfToken(result.csrfToken);
    queryClient.setQueryData<AuthMe>(['auth-me'], {
      mode: 'hosted',
      user: result.user,
      csrfToken: result.csrfToken,
    });
  };

  const logout = async () => {
    await portalLogout();
    setCsrfToken(null);
    queryClient.clear();
    queryClient.setQueryData<AuthMe>(['auth-me'], { mode: 'hosted', user: null, csrfToken: null });
  };

  return (
    <AuthContext.Provider
      value={{
        me,
        loading: meQuery.isLoading,
        authenticated: me?.mode === 'local' || me?.user != null,
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
