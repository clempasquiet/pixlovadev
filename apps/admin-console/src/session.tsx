import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { PlatformPermission } from '@pixlova/permissions';
import { api, ApiRequestError, setUnauthorizedHandler, type Me } from './api.js';

interface SessionState {
  status: 'loading' | 'anonymous' | 'mfa' | 'enrolling' | 'ready';
  me: Me | null;
  refresh(): Promise<void>;
  can(permission: PlatformPermission): boolean;
  /**
   * Exécute une action dangereuse ; si le serveur exige un second facteur récent, demande
   * le code TOTP, réauthentifie puis rejoue l’action une fois.
   */
  protect<T>(action: () => Promise<T>): Promise<T>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionState['status']>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [prompt, setPrompt] = useState<{
    resolve(code: string): void;
    reject(error: Error): void;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const current = await api<Me>('GET', '/auth/me');
      setMe(current);
      setStatus(
        current.session.enrolling ? 'enrolling' : current.session.mfa_pending ? 'mfa' : 'ready',
      );
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        setMe(null);
        setStatus('anonymous');
      } else throw error;
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setMe(null);
      setStatus('anonymous');
    });
    void refresh();
  }, [refresh]);

  const protect = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof ApiRequestError) || error.code !== 'RECENT_AUTH_REQUIRED') throw error;
      const code = await new Promise<string>((resolve, reject) => setPrompt({ resolve, reject }));
      await api('POST', '/auth/reauthenticate', { code });
      return action();
    }
  }, []);

  const value = useMemo<SessionState>(
    () => ({
      status,
      me,
      refresh,
      protect,
      can: (permission) => Boolean(me?.permissions.includes(permission)),
    }),
    [status, me, refresh, protect],
  );

  return (
    <SessionContext.Provider value={value}>
      {children}
      {prompt && (
        <MfaDialog
          onSubmit={(code) => {
            prompt.resolve(code);
            setPrompt(null);
          }}
          onCancel={() => {
            prompt.reject(new Error('Action annulée.'));
            setPrompt(null);
          }}
        />
      )}
    </SessionContext.Provider>
  );
}

function MfaDialog(props: { onSubmit(code: string): void; onCancel(): void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <div className="dialog-backdrop">
      <form
        className="card dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mfa-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit(String(new FormData(event.currentTarget).get('code') ?? ''));
        }}
      >
        <h2 id="mfa-dialog-title">Confirmer avec votre second facteur</h2>
        <p className="muted">Action sensible : saisissez le code de votre application TOTP.</p>
        <div className="field">
          <label htmlFor="mfa-dialog-code">Code à 6 chiffres</label>
          <input
            ref={input}
            id="mfa-dialog-code"
            name="code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            autoComplete="one-time-code"
            required
          />
        </div>
        <div className="actions">
          <button type="submit">Confirmer</button>
          <button type="button" className="secondary" onClick={props.onCancel}>
            Annuler
          </button>
        </div>
      </form>
    </div>
  );
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) throw new Error('SessionProvider manquant.');
  return context;
}
