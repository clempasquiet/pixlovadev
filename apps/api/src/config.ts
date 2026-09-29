export interface ListenerConfig {
  host: string;
  port: number;
}

export interface ApiConfig {
  /** Listener exposé via le tunnel public : `/api/v1`, `/player/v1`, webhooks. */
  public: ListenerConfig;
  /** Listener réservé au réseau privé : `/internal/v1` (API-001). */
  internal: ListenerConfig;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const config: ApiConfig = {
    public: { host: env.PUBLIC_HOST ?? '0.0.0.0', port: readPort(env, 'PUBLIC_PORT', 3000) },
    internal: {
      host: env.INTERNAL_HOST ?? '127.0.0.1',
      port: readPort(env, 'INTERNAL_PORT', 3001),
    },
  };
  if (config.public.port === config.internal.port) {
    throw new Error('Les listeners public et interne doivent utiliser des ports distincts.');
  }
  return config;
}
