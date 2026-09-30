export interface ListenerConfig {
  host: string;
  port: number;
}

export interface SecurityConfig {
  /** Origines autorisées pour les requêtes modifiantes du dashboard (protection CSRF). */
  allowedOrigins: string[];
  /** URL publique du dashboard, utilisée dans les liens des emails. */
  appBaseUrl: string;
  cookieSecure: boolean;
  sessionIdleHours: number;
  sessionAbsoluteDays: number;
  recentAuthMinutes: number;
  emailVerificationHours: number;
  passwordResetMinutes: number;
  invitationDays: number;
  /** IAM-007 : MFA exigée des Owner/Admin pour les actions sensibles. */
  requireMfaForAdmins: boolean;
}

export interface ApiConfig {
  /** Listener exposé via le tunnel public : `/api/v1`, `/player/v1`, webhooks. */
  public: ListenerConfig;
  /** Listener réservé au réseau privé : `/internal/v1` (API-001). */
  internal: ListenerConfig;
  security: SecurityConfig;
}

function readPort(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} doit être un port TCP entre 1 et 65535.`);
  }
  return port;
}

function readNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} doit être compris entre ${min} et ${max}.`);
  }
  return value;
}

/**
 * Valeurs par défaut = [PROPOSITION] du cahier des charges (§24.2) ou choix documentés
 * dans l’ADR-006 ; toutes sont surchargeables par l’environnement.
 */
export function defaultSecurityConfig(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const appBaseUrl = env.PIXLOVA_APP_BASE_URL ?? 'http://localhost:5173';
  return {
    allowedOrigins: (env.PIXLOVA_ALLOWED_ORIGINS ?? new URL(appBaseUrl).origin)
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    appBaseUrl,
    cookieSecure: env.PIXLOVA_COOKIE_SECURE !== 'false',
    sessionIdleHours: readNumber(env, 'PIXLOVA_SESSION_IDLE_HOURS', 24, 1, 24 * 30),
    sessionAbsoluteDays: readNumber(env, 'PIXLOVA_SESSION_ABSOLUTE_DAYS', 14, 1, 90),
    recentAuthMinutes: readNumber(env, 'PIXLOVA_RECENT_AUTH_MINUTES', 15, 1, 120),
    emailVerificationHours: readNumber(env, 'PIXLOVA_EMAIL_VERIFICATION_HOURS', 24, 1, 168),
    passwordResetMinutes: readNumber(env, 'PIXLOVA_PASSWORD_RESET_MINUTES', 60, 5, 1440),
    invitationDays: readNumber(env, 'PIXLOVA_INVITATION_DAYS', 7, 1, 30),
    requireMfaForAdmins: env.PIXLOVA_REQUIRE_MFA_FOR_ADMINS !== 'false',
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const config: ApiConfig = {
    public: { host: env.PUBLIC_HOST ?? '0.0.0.0', port: readPort(env, 'PUBLIC_PORT', 3000) },
    internal: {
      host: env.INTERNAL_HOST ?? '127.0.0.1',
      port: readPort(env, 'INTERNAL_PORT', 3001),
    },
    security: defaultSecurityConfig(env),
  };
  if (config.public.port === config.internal.port) {
    throw new Error('Les listeners public et interne doivent utiliser des ports distincts.');
  }
  return config;
}
