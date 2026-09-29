import type { MediaErrorCode } from '@pixlova/contracts';

/**
 * Échec définitif : le fichier ne deviendra pas valide par une nouvelle tentative
 * (format, corruption, limite). Le média passe en erreur avec ce code, sans reprise.
 */
export class PermanentMediaError extends Error {
  override readonly name = 'PermanentMediaError';
  constructor(
    readonly code: MediaErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

/** Tâche interrompue : le bail a été perdu ou le worker s’arrête. */
export class JobAbortedError extends Error {
  override readonly name = 'JobAbortedError';
}
