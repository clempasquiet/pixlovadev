import type { MediaLimits } from '@pixlova/contracts';
import type { Database } from '@pixlova/db';
import type { ManifestSigner } from '@pixlova/scheduling/compiler';
import type { ObjectStorage } from '@pixlova/storage';
import type { VideoTools } from './media/video.js';

export interface Logger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface WorkerContext {
  /** Rôle applicatif soumis à RLS : toute écriture métier se fait sous `withTenant`. */
  appDb: Database;
  /** Rôle système : réclamation des tâches et balayages inter-tenants uniquement. */
  systemDb: Database;
  storage: ObjectStorage;
  limits: MediaLimits;
  tools: VideoTools;
  /** Répertoire des fichiers temporaires, un sous-dossier par tâche. */
  tmpRoot: string;
  trashRetentionDays: number;
  /** Clé Ed25519 du compilateur de manifests (ADR-011) ; absente, les compilations échouent. */
  manifestSigner?: ManifestSigner | null;
  now: () => Date;
  logger: Logger;
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function consoleLogger(): Logger {
  const write =
    (level: string) =>
    (fields: Record<string, unknown>, message: string): void => {
      process.stdout.write(
        `${JSON.stringify({ level, time: new Date().toISOString(), msg: message, ...fields })}\n`,
      );
    };
  return { info: write('info'), warn: write('warn'), error: write('error') };
}
