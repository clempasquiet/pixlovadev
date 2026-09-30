import type { Database } from '@pixlova/db';
import type { DataCipher } from '../lib/crypto.js';
import type { EntitlementsProvider } from '../lib/entitlements.js';
import type { RateLimiter } from '../lib/rate-limit.js';
import type { AdminConfig } from './config.js';

/** Dépendances de l’administration plateforme, injectées (tests, serveur). */
export interface AdminServices {
  /** Rôle `pixlova_platform` (ADR-016) : lecture de support bornée, tables des opérateurs. */
  platform: Database;
  cipher: DataCipher;
  limiter: RateLimiter;
  /** Même source des droits que l’API : la vue montre ce qui est réellement appliqué. */
  entitlements: EntitlementsProvider;
  config: AdminConfig;
  now(): Date;
}
