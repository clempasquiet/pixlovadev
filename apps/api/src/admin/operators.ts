import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database, type Transaction } from '@pixlova/db';
import type { PlatformRole } from '@pixlova/permissions';
import { randomToken, tokenHash } from '../lib/crypto.js';

export interface IssuedActivation {
  operatorId: string;
  /** Code à usage unique, affiché une seule fois à l’émetteur, jamais stocké en clair. */
  activationCode: string;
  expiresAt: Date;
}

/**
 * (Ré)initialise l’accès d’un opérateur : compte `pending`, mot de passe et TOTP retirés,
 * sessions révoquées, anciens codes invalidés, nouveau code d’activation.
 */
export async function issueActivation(
  tx: Database | Transaction,
  operatorId: string,
  issuedBy: string | null,
  now: Date,
  validityHours: number,
): Promise<IssuedActivation> {
  await tx
    .update(schema.platformUsers)
    .set({ status: 'pending', passwordHash: null, updatedAt: now })
    .where(eq(schema.platformUsers.id, operatorId));
  await tx
    .update(schema.platformMfaCredentials)
    .set({ revokedAt: now })
    .where(
      and(
        eq(schema.platformMfaCredentials.platformUserId, operatorId),
        isNull(schema.platformMfaCredentials.revokedAt),
      ),
    );
  await tx
    .update(schema.platformSessions)
    .set({ revokedAt: now, revokeReason: 'activation_reissued' })
    .where(
      and(
        eq(schema.platformSessions.platformUserId, operatorId),
        isNull(schema.platformSessions.revokedAt),
      ),
    );
  await tx
    .update(schema.platformActivationTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(schema.platformActivationTokens.platformUserId, operatorId),
        isNull(schema.platformActivationTokens.usedAt),
      ),
    );
  const activationCode = randomToken();
  const expiresAt = new Date(now.getTime() + validityHours * 3_600_000);
  await tx.insert(schema.platformActivationTokens).values({
    platformUserId: operatorId,
    tokenHash: tokenHash(activationCode),
    expiresAt,
    createdBy: issuedBy,
  });
  return { operatorId, activationCode, expiresAt };
}

/** Crée un opérateur `pending` avec ses rôles et son premier code d’activation. */
export async function createOperator(
  tx: Database | Transaction,
  input: { email: string; displayName: string; roles: readonly PlatformRole[] },
  createdBy: string | null,
  now: Date,
  validityHours: number,
): Promise<IssuedActivation> {
  const [operator] = await tx
    .insert(schema.platformUsers)
    .values({
      emailNormalized: input.email.trim().toLowerCase(),
      displayName: input.displayName,
      status: 'pending',
      createdBy,
    })
    .returning({ id: schema.platformUsers.id });
  if (input.roles.length > 0) {
    await tx
      .insert(schema.platformUserRoles)
      .values(
        input.roles.map((role) => ({ platformUserId: operator!.id, role, grantedBy: createdBy })),
      );
  }
  return issueActivation(tx, operator!.id, createdBy, now, validityHours);
}
