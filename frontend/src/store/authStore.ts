import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface AuthUser {
  id: string;
  email: string;
  role: 'ADMIN';
}

interface AuthStore {
  user: AuthUser | null;
  accessToken: string | null;
  setAuth: (user: AuthUser, token: string) => void;
  setAccessToken: (token: string) => void;
  logout: () => void;
}

// Persist auth to localStorage so refresh / new tab keeps the operator logged in.
// The refresh token is an HttpOnly cookie set by /api/auth/login; localStorage
// only holds the short-lived access token + user identity. On 401, api.ts hits
// /api/auth/refresh (cookie-based) and silently rotates the access token.
export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      setAuth: (user, accessToken) => set({ user, accessToken }),
      setAccessToken: (accessToken) => set({ accessToken }),
      logout: () => set({ user: null, accessToken: null }),
    }),
    {
      name: 'vfs-bot-auth',
      storage: createJSONStorage(() => (typeof window !== 'undefined' ? window.localStorage : ({} as Storage))),
      partialize: (state) => ({ user: state.user, accessToken: state.accessToken }),
    },
  ),
);
