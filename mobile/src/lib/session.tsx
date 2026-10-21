import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SessionContext } from '@df/types';
import { ApiError, DEFAULT_SERVER, createApi, normalizeServerUrl, type Api } from './api';
import { storage } from './storage';

type State =
  | { phase: 'loading' }
  | { phase: 'signed-out'; server: string }
  | { phase: 'signed-in'; server: string; token: string; session: SessionContext }
  | { phase: 'offline'; server: string; token: string; message: string };

type SessionValue = {
  state: State;
  api: Api;
  server: string | null;
  setServer: (url: string) => Promise<void>;
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
};

const Context = createContext<SessionValue | null>(null);

/**
 * Where the app stands: which server it talks to and who is signed in. A revoked or expired session
 * (any 401) leads back to the sign-in screen.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const server = state.phase === 'loading' ? null : state.server;
  const token = state.phase === 'signed-in' || state.phase === 'offline' ? state.token : null;

  const signedOut = useCallback(async (url: string) => {
    await storage.clearToken();
    setState({ phase: 'signed-out', server: url });
  }, []);

  const open = useCallback(async (url: string, sessionToken: string | null) => {
    if (!sessionToken) return setState({ phase: 'signed-out', server: url });
    try {
      const session = await createApi(url, sessionToken, () => {}).session();
      setState({ phase: 'signed-in', server: url, token: sessionToken, session });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return signedOut(url);
      setState({ phase: 'offline', server: url, token: sessionToken, message: (error as Error).message });
    }
  }, [signedOut]);

  useEffect(() => {
    void (async () => {
      // Everyone works on the public server; another address is set only for tests (long press on the sign-in title).
      const url = await storage.server() ?? normalizeServerUrl(DEFAULT_SERVER);
      await open(url, await storage.token());
    })();
  }, [open]);

  const value = useMemo<SessionValue>(() => ({
    state,
    server,
    api: createApi(server ?? '', token, () => { if (server) void signedOut(server); }),
    setServer: async (url) => {
      await storage.setServer(url);
      await storage.clearToken();
      setState({ phase: 'signed-out', server: url });
    },
    signIn: async (newToken) => {
      if (!server) return;
      await storage.setToken(newToken);
      await open(server, newToken);
    },
    signOut: async () => { if (server) await signedOut(server); },
    reload: async () => { if (server) await open(server, token); }
  }), [state, server, token, open, signedOut]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSession() {
  const value = useContext(Context);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}

/** The signed-in session; only for screens behind the sign-in guard. */
export function useSignedIn() {
  const { state } = useSession();
  if (state.phase !== 'signed-in') throw new Error('useSignedIn without a session');
  return state.session;
}
