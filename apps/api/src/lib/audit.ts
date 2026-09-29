import { schema, type Database, type Transaction } from '@pixlova/db';

export interface AuditEntry {
  organizationId: string | null;
  actorType: 'user' | 'player' | 'platform_user' | 'system';
  actorId: string | null;
  action: string;
  permission?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  result: 'success' | 'denied' | 'failed';
  reason?: string | null;
  requestId?: string | null;
  ip?: string | null;
  /** Métadonnées non sensibles : jamais de mot de passe, jeton, code MFA ou cookie (IAM-008). */
  metadata?: Record<string, string | number | boolean | null | string[]>;
}

const FORBIDDEN_KEYS = /pass|token|secret|code|cookie|otp/i;

export function sanitizeMetadata(metadata: AuditEntry['metadata'] = {}): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !FORBIDDEN_KEYS.test(key)));
}

/**
 * Écrit une entrée d’audit dans la transaction de l’action (IAM-008, SEC-016).
 * Une action d’un tenant utilise la transaction tenant ; une action de compte
 * (sans organisation) passe par le rôle système.
 */
export async function audit(tx: Transaction | Database, entry: AuditEntry): Promise<void> {
  await tx.insert(schema.auditLogs).values({
    organizationId: entry.organizationId,
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    permission: entry.permission ?? null,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    result: entry.result,
    reason: entry.reason ?? null,
    requestId: entry.requestId ?? null,
    ip: entry.ip ?? null,
    metadata: sanitizeMetadata(entry.metadata),
  });
}
