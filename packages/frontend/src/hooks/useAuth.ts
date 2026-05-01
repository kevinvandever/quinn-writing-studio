import { useEffect } from 'react';
import { useAuthStore, User } from '../stores/authStore';

interface UseAuthReturn {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

/**
 * Hook wrapping the auth Zustand store.
 * Provides login, logout, session validation on mount, and auth state access.
 */
export function useAuth(): UseAuthReturn {
  const { user, isAuthenticated, isLoading, error, login, logout, checkSession } =
    useAuthStore();

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  return {
    user,
    isAuthenticated,
    isLoading,
    error,
    login,
    logout,
  };
}
