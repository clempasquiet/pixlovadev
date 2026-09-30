import type { MediaLimits } from '@pixlova/contracts';
import type { Database } from '@pixlova/db';
import type { ObjectStorage } from '@pixlova/storage';
import type { MediaConfig, SecurityConfig, SupervisionConfig } from '../config.js';
import type { DataCipher } from '../lib/crypto.js';
import type { EntitlementsProvider } from '../lib/entitlements.js';
import type { RateLimiter } from '../lib/rate-limit.js';

/** Dépendances des routes `/api/v1`, injectées (tests, serveur). */
export interface Services {
  /** Rôle `pixlova_app` : soumis à RLS, toujours sous `withTenant` pour les données d’un tenant. */
  db: Database;
  /** Rôle `pixlova_system` : réservé aux opérations inter-tenants nommées (ADR-004). */
  system: Database;
  cipher: DataCipher;
  limiter: RateLimiter;
  entitlements: EntitlementsProvider;
  security: SecurityConfig;
  /** Stockage objet privé (ADR-009) : seules des URLs signées sortent de l’API. */
  storage: ObjectStorage;
  media: MediaConfig & { limits: MediaLimits };
  supervision: SupervisionConfig;
  now(): Date;
}
