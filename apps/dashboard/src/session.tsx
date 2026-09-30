import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Permission } from '@pixlova/permissions';
import {
  api,
  ApiRequestError,
  setActiveOrganization,
  setUnauthorizedHandler,
  type Grant,
  type Me,
} from './api.js';

const STORAGE_KEY = 'pixlova.activeOrganization';

interface SessionState {
  status: 'loading' | 'anonymous' | 'mfa' | 'ready';
  me: Me | null;
  organizationId: string | null;
  permissions: Permission[];
  grants: Grant[];
  refresh(): Promise<void>;
  selectOrganization(id: string): void;
  can(permission: Permission): boolean;
}

const SessionContext = createContext<SessionState | null>(null);

function storedOrganization(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionState['status']>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(storedOrganization());
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);

  const refresh = useCallback(async () => {
    try {
      const current = await api<Me>('GET', '/auth/me');
      setMe(current);
      if (current.mfa_pending) {
        setStatus('mfa');
        return;
      }
      // L’organisation active doit exister parmi les appartenances du compte (IAM-001).
      const known = current.organizations.map((o) => o.id);
      const next =
        organizationId && known.includes(organizationId) ? organizationId : (known[0] ?? null);
      setOrganizationId(next);
      setActiveOrganization(next);
      if (next) {
        const effective = await api<{ permissions: Permission[]; grants: Grant[] }>(
          'GET',
          '/permissions',
        );
        setPermissions(effective.permissions);
        setGrants(effective.grants);
      } else {
        setPermissions([]);
        setGrants([]);
      }
      setStatus('ready');
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        setMe(null);
        setStatus('anonymous');
        return;
      }
      throw error;
    }
  }, [organizationId]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setMe(null);
      setStatus('anonymous');
    });
    void refresh();
    // Chargement initial uniquement ; les changements passent par refresh().
  }, []);

  useEffect(() => {
    try {
      if (organizationId) localStorage.setItem(STORAGE_KEY, organizationId);
    } catch {
      // Stockage indisponible (navigation privée) : l’organisation reste en mémoire.
    }
  }, [organizationId]);

  const selectOrganization = useCallback((id: string) => {
    setOrganizationId(id);
    setActiveOrganization(id);
  }, []);

  useEffect(() => {
    if (status === 'ready' && organizationId) void refresh();
    // Recharge les permissions à chaque changement d’organisation.
  }, [organizationId]);

  const value = useMemo<SessionState>(
    () => ({
      status,
      me,
      organizationId,
      permissions,
      grants,
      refresh,
      selectOrganization,
      can: (permission) => permissions.includes(permission),
    }),
    [status, me, organizationId, permissions, grants, refresh, selectOrganization],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession hors de SessionProvider');
  return context;
}

export function useActiveOrganization() {
  const { me, organizationId } = useSession();
  return me?.organizations.find((o) => o.id === organizationId) ?? null;
}
