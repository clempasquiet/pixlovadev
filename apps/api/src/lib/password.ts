import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id (SEC-001), paramètres OWASP 2026 : 19 Mio, 2 itérations, parallélisme 1.
 * Les paramètres sont inscrits dans chaque empreinte (format PHC) : une évolution
 * n’invalide pas les comptes existants et `needsRehash` permet la migration à la connexion.
 */
export const ARGON2_PARAMS = {
  /** `Algorithm.Argon2id` (enum `const` non importable avec `verbatimModuleSyntax`). */
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_BYTES = 256;

export type PasswordProblem = 'TOO_SHORT' | 'TOO_LONG' | 'CONTAINS_EMAIL';

export function passwordProblem(password: string, email: string): PasswordProblem | null {
  if ([...password].length < PASSWORD_MIN_LENGTH) return 'TOO_SHORT';
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return 'TOO_LONG';
  const local = email.split('@')[0] ?? '';
  if (local.length >= 4 && password.toLowerCase().includes(local.toLowerCase()))
    return 'CONTAINS_EMAIL';
  return null;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_PARAMS);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

export function needsRehash(stored: string): boolean {
  return !stored.startsWith(
    `$argon2id$v=19$m=${ARGON2_PARAMS.memoryCost},t=${ARGON2_PARAMS.timeCost},p=${ARGON2_PARAMS.parallelism}$`,
  );
}

/** Empreinte factice : vérifiée quand le compte n’existe pas, pour un temps de réponse comparable. */
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword('pixlova-compte-inexistant');
  return dummy;
}
