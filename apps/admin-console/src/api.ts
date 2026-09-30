/** Client HTTP de la console : même origine que le serveur d’administration, cookie de session. */

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

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  reason?: string,
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (reason) headers['x-support-reason'] = reason;
  let response: Response;
  try {
    response = await fetch(`/admin-api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiRequestError(0, {
      code: 'NETWORK_ERROR',
      message: 'Serveur d’administration injoignable.',
      request_id: '',
      retryable: true,
    });
  }
  const payload = (await response.json().catch(() => null)) as { error?: ApiErrorBody } | null;
  if (!response.ok) {
    const error = payload?.error ?? {
      code: 'UNKNOWN_ERROR',
      message: `Erreur inattendue (${response.status}).`,
      request_id: '',
      retryable: response.status >= 500,
    };
    if (response.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.();
    throw new ApiRequestError(response.status, error);
  }
  return payload as T;
}

export interface Me {
  operator: { id: string; email: string; display_name: string; status: string };
  roles: string[];
  permissions: string[];
  session: {
    mfa_pending: boolean;
    enrolling: boolean;
    expires_at: string;
    authenticated_at: string;
  };
}

export const ROLE_LABELS: Record<string, string> = {
  super_admin: 'SuperAdmin',
  support: 'Support',
  billing_admin: 'BillingAdmin',
  operations: 'Operator (exploitation)',
  content_admin: 'ContentAdmin',
};

export function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('fr-FR') : '—';
}

export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'indisponible';
  const units = ['o', 'ko', 'Mo', 'Go', 'To'];
  let size = value;
  let unit = 0;
  while (size >= 1000 && unit < units.length - 1) {
    size /= 1000;
    unit++;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
