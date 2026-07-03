import { create } from "zustand";
import { api, restoreSession, setAccessToken } from "../api/client";

// Brand-neutral storage key so a future rebrand needs no migration.
const SESSION_USER_KEY = "auth_user";

interface AuthState {
  username: string | null;
  isAuthenticated: boolean;
  // True while we're attempting to restore a session on first load — the router
  // waits for this so a page refresh doesn't flash the login screen / log out.
  bootstrapping: boolean;
  loading: boolean;
  error: string | null;
  restore: () => Promise<void>;
  login: (username: string, password: string) => Promise<boolean>;
  register: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  clearSession: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  username: sessionStorage.getItem(SESSION_USER_KEY),
  isAuthenticated: false,
  bootstrapping: true,
  loading: false,
  error: null,

  restore: async () => {
    try {
      const username = await restoreSession();
      if (username) {
        sessionStorage.setItem(SESSION_USER_KEY, username);
        set({ username, isAuthenticated: true, bootstrapping: false });
      } else {
        sessionStorage.removeItem(SESSION_USER_KEY);
        set({ username: null, isAuthenticated: false, bootstrapping: false });
      }
    } catch {
      set({ isAuthenticated: false, bootstrapping: false });
    }
  },

  login: async (username, password) => {
    set({ loading: true, error: null });
    try {
      const { access_token } = await api.login(username, password);
      setAccessToken(access_token);
      sessionStorage.setItem(SESSION_USER_KEY, username);
      set({ username, isAuthenticated: true, loading: false });
      return true;
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : "Login failed" });
      return false;
    }
  },

  register: async (username, password) => {
    set({ loading: true, error: null });
    try {
      await api.register(username, password);
      set({ loading: false });
      return true;
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : "Registration failed" });
      return false;
    }
  },

  logout: async () => {
    try {
      await api.logout();
    } catch {
      /* ignore network errors on logout */
    }
    setAccessToken(null);
    sessionStorage.removeItem(SESSION_USER_KEY);
    set({ username: null, isAuthenticated: false });
  },

  clearSession: () => {
    setAccessToken(null);
    sessionStorage.removeItem(SESSION_USER_KEY);
    set({ username: null, isAuthenticated: false });
  },
}));
