/** Client HTTP du dashboard : même origine, cookie de session, organisation active en en-tête. */

export interface ApiErrorBody {
  code: string;
  message: string;
  request_id: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'ApiRequestError';
  }
  get code(): string {
    return this.body.code;
  }
}

let activeOrganization: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setActiveOrganization(id: string | null): void {
  activeOrganization = id;
}

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...extraHeaders };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (activeOrganization) headers['x-organization-id'] = activeOrganization;
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiRequestError(0, {
      code: 'NETWORK_ERROR',
      message: 'Service injoignable. Vérifiez votre connexion puis réessayez.',
      request_id: '',
      retryable: true,
    });
  }
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as { error?: ApiErrorBody } | null;
  if (!response.ok) {
    const error = payload?.error ?? {
      code: 'UNKNOWN_ERROR',
      message: `Erreur inattendue (${response.status}).`,
      request_id: '',
      retryable: response.status >= 500,
    };
    if (response.status === 401 && path !== '/auth/login') onUnauthorized?.();
    throw new ApiRequestError(response.status, error);
  }
  return payload as T;
}

export interface Me {
  user: { id: string; email: string; display_name: string | null; mfa_enabled: boolean };
  mfa_pending: boolean;
  organizations: { id: string; name: string; slug: string; roles: string[] }[];
}

export interface Grant {
  role: string;
  scope: { type: 'organization' } | { type: 'sites'; site_ids: string[] };
}

/** Clé d’idempotence d’une action utilisateur (API-005) : une par clic, réutilisée en cas de reprise. */
export function idempotencyKey(): Record<string, string> {
  return { 'idempotency-key': crypto.randomUUID() };
}
