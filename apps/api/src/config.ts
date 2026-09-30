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
  /** Durée de validité d’un code d’appairage (PROTO-001, 5 min proposé). */
  pairingCodeMinutes: number;
  /** Jeton d’accès Player (PROTO-002, 15 min proposé) et challenge (60 s). */
  playerTokenMinutes: number;
  playerChallengeSeconds: number;
  /** Heartbeat nominal et seuil de présence (SUP-002 : 30 s / 90 s). */
  heartbeatIntervalSeconds: number;
  presenceTimeoutSeconds: number;
}

/** Bibliothèque média (ADR-009) ; valeurs proposées, à valider par le responsable produit. */
export interface MediaConfig {
  /** Rétention de la corbeille avant purge définitive (MED-008, 30 j proposés). */
  trashRetentionDays: number;
  /** Validité d’une URL d’envoi direct. */
  uploadUrlMinutes: number;
  /** Validité d’une URL d’aperçu remise au dashboard. */
  previewUrlSeconds: number;
}

export function defaultMediaConfig(env: NodeJS.ProcessEnv = process.env): MediaConfig {
  return {
    trashRetentionDays: readNumber(env, 'PIXLOVA_MEDIA_TRASH_RETENTION_DAYS', 30, 1, 3650),
    uploadUrlMinutes: readNumber(env, 'PIXLOVA_MEDIA_UPLOAD_URL_MINUTES', 15, 1, 120),
    previewUrlSeconds: readNumber(env, 'PIXLOVA_MEDIA_PREVIEW_URL_SECONDS', 300, 30, 3600),
  };
}

export interface ApiConfig {
  /** Listener exposé via le tunnel public : `/api/v1`, `/player/v1`, webhooks. */
  public: ListenerConfig;
  /** Listener réservé au réseau privé : `/internal/v1` (API-001). */
  internal: ListenerConfig;
  security: SecurityConfig;
  media: MediaConfig;
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
    pairingCodeMinutes: readNumber(env, 'PIXLOVA_PAIRING_CODE_MINUTES', 5, 1, 60),
    playerTokenMinutes: readNumber(env, 'PIXLOVA_PLAYER_TOKEN_MINUTES', 15, 1, 120),
    playerChallengeSeconds: readNumber(env, 'PIXLOVA_PLAYER_CHALLENGE_SECONDS', 60, 10, 600),
    heartbeatIntervalSeconds: readNumber(env, 'PIXLOVA_HEARTBEAT_SECONDS', 30, 5, 600),
    presenceTimeoutSeconds: readNumber(env, 'PIXLOVA_PRESENCE_TIMEOUT_SECONDS', 90, 10, 3600),
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
    media: defaultMediaConfig(env),
  };
  if (config.public.port === config.internal.port) {
    throw new Error('Les listeners public et interne doivent utiliser des ports distincts.');
  }
  return config;
}
