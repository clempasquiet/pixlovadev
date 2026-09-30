import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { schema, type Transaction } from '@pixlova/db';
import { canonicalJson } from '@pixlova/contracts';
import { ApiError } from '../errors.js';

const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

export interface IdempotencyScope {
  organizationId: string;
  actorId: string;
  operation: string;
  key: string;
  requestHash: string;
}

/** En-tête `Idempotency-Key` obligatoire pour les opérations sensibles (API-005). */
export function idempotencyScope(
  request: FastifyRequest,
  organizationId: string,
  actorId: string,
  operation: string,
): IdempotencyScope {
  const header = request.headers['idempotency-key'];
  const key = typeof header === 'string' ? header : '';
  if (!KEY.test(key)) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'En-tête Idempotency-Key requis (8 à 128 caractères).',
    );
  }
  const requestHash = createHash('sha256')
    .update(canonicalJson({ params: request.params ?? {}, body: request.body ?? {} }))
    .digest('hex');
  return { organizationId, actorId, operation, key, requestHash };
}

/**
 * Exécute `work` une seule fois par clé, dans la transaction fournie (qui doit fixer le
 * tenant ou utiliser le rôle système). Même clé + même requête : réponse enregistrée.
 * Même clé + requête différente : `IDEMPOTENCY_CONFLICT`.
 */
export async function idempotent<T extends object>(
  tx: Transaction,
  scope: IdempotencyScope,
  work: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  const where = and(
    eq(schema.idempotencyKeys.organizationId, scope.organizationId),
    eq(schema.idempotencyKeys.actorId, scope.actorId),
    eq(schema.idempotencyKeys.operation, scope.operation),
    eq(schema.idempotencyKeys.key, scope.key),
  );
  const [existing] = await tx.select().from(schema.idempotencyKeys).where(where);
  if (existing) {
    if (existing.requestHash !== scope.requestHash) {
      throw new ApiError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'Cette clé d’idempotence a déjà servi pour une autre requête.',
      );
    }
    return { status: existing.responseStatus, body: existing.responseBody as T, replayed: true };
  }
  const result = await work();
  await tx.insert(schema.idempotencyKeys).values({
    organizationId: scope.organizationId,
    actorId: scope.actorId,
    operation: scope.operation,
    key: scope.key,
    requestHash: scope.requestHash,
    responseStatus: result.status,
    responseBody: result.body,
  });
  return { ...result, replayed: false };
}
