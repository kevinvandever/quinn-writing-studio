import { create } from 'zustand';
import { post, get } from '../services/api-client';

export interface User {
  id: string;
  email: string;
  displayName: string;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  clearError: () => void;
}

// Persist auth state to localStorage for mobile resilience
function saveAuth(user: User, token?: string) {
  try {
    localStorage.setItem('quinn_user', JSON.stringify(user));
    if (token) {
      localStorage.setItem('quinn_token', token);
    }
  } catch {
    // localStorage unavailable (private browsing, etc.)
  }
}

function clearAuth() {
  try {
    localStorage.removeItem('quinn_user');
    localStorage.removeItem('quinn_token');
  } catch {
    // ignore
  }
}

function loadAuth(): { user: User | null; token: string | null } {
  try {
    const userStr = localStorage.getItem('quinn_user');
    const token = localStorage.getItem('quinn_token');
    if (userStr) {
      return { user: JSON.parse(userStr) as User, token };
    }
  } catch {
    // ignore
  }
  return { user: null, token: null };
}

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem('quinn_token');
  } catch {
    return null;
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  error: null,

  login: async (email: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await post<{ user: User; token?: string }>('/api/auth/login', {
        email,
        password,
      });
      saveAuth(response.user, response.token);
      set({ user: response.user, isAuthenticated: true, isLoading: false });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Login failed';
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  register: async (email: string, password: string, displayName: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await post<{ user: User; token?: string }>('/api/auth/register', {
        email,
        password,
        displayName,
      });
      saveAuth(response.user, response.token);
      set({ user: response.user, isAuthenticated: true, isLoading: false });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Registration failed';
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  logout: async () => {
    try {
      await post('/api/auth/logout');
    } finally {
      clearAuth();
      set({ user: null, isAuthenticated: false, isLoading: false, error: null });
    }
  },

  checkSession: async () => {
    set({ isLoading: true });
    try {
      const response = await get<{ user: User }>('/api/auth/session');
      saveAuth(response.user);
      set({ user: response.user, isAuthenticated: true, isLoading: false });
    } catch {
      // If server check fails, try localStorage fallback (mobile cookie issues)
      const { user } = loadAuth();
      if (user) {
        set({ user, isAuthenticated: true, isLoading: false });
      } else {
        clearAuth();
        set({ user: null, isAuthenticated: false, isLoading: false });
      }
    }
  },

  clearError: () => set({ error: null }),
}));
