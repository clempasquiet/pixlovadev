/**
 * Configuration de l’administration plateforme (ADR-016). Durées proposées **[à valider]**
 * (ADM-002 : « sessions courtes », durées configurables).
 */
export interface AdminConfig {
  /** Origines autorisées pour les requêtes modifiantes de la console (CSRF). */
  allowedOrigins: string[];
  cookieSecure: boolean;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  /** Second facteur ressaisi depuis moins de N minutes pour les actions dangereuses. */
  recentAuthMinutes: number;
  /** Validité d’un code d’activation d’opérateur. */
  activationHours: number;
  /** Seuil de présence des Players (identique à l’API, SUP-002). */
  presenceTimeoutSeconds: number;
}

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} invalide.`);
  return value;
}

export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const origins = (env.PIXLOVA_ADMIN_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) throw new Error('PIXLOVA_ADMIN_ALLOWED_ORIGINS est requis.');
  return {
    allowedOrigins: origins,
    cookieSecure: env.PIXLOVA_ADMIN_COOKIE_SECURE !== 'false',
    sessionIdleMinutes: positive(env, 'PIXLOVA_ADMIN_SESSION_IDLE_MINUTES', 30),
    sessionAbsoluteHours: positive(env, 'PIXLOVA_ADMIN_SESSION_ABSOLUTE_HOURS', 8),
    recentAuthMinutes: positive(env, 'PIXLOVA_ADMIN_RECENT_AUTH_MINUTES', 5),
    activationHours: positive(env, 'PIXLOVA_ADMIN_ACTIVATION_HOURS', 24),
    presenceTimeoutSeconds: positive(env, 'PIXLOVA_PRESENCE_TIMEOUT_SECONDS', 90),
  };
}
