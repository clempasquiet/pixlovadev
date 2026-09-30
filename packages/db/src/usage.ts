import { and, eq, sql } from 'drizzle-orm';
import type { Transaction } from './index.js';
import { usageCounters } from './schema/index.js';

export type UsageCategory = 'storage_bytes';

/**
 * Verrouille le compteur d’usage de l’organisation (DATA-008) et le crée au besoin.
 * Toute réservation ou consommation passe par ce verrou : pas de course « lire puis créer ».
 */
export async function lockUsage(
  tx: Transaction,
  organizationId: string,
  category: UsageCategory,
): Promise<{ observed: number; reserved: number }> {
  await tx.insert(usageCounters).values({ organizationId, category }).onConflictDoNothing();
  const [row] = await tx
    .select({ observed: usageCounters.observedValue, reserved: usageCounters.reservedValue })
    .from(usageCounters)
    .where(
      and(eq(usageCounters.organizationId, organizationId), eq(usageCounters.category, category)),
    )
    .for('update');
  if (!row) throw new Error('Compteur d’usage introuvable.');
  return row;
}

/**
 * Ajuste le compteur (valeurs relatives). Les valeurs restent positives ; un écart est
 * corrigé par la réconciliation, jamais par une suppression de données.
 */
export async function adjustUsage(
  tx: Transaction,
  organizationId: string,
  category: UsageCategory,
  delta: { observed?: number; reserved?: number },
  now: Date,
): Promise<void> {
  await lockUsage(tx, organizationId, category);
  await tx
    .update(usageCounters)
    .set({
      observedValue: sql`greatest(${usageCounters.observedValue} + ${delta.observed ?? 0}, 0)`,
      reservedValue: sql`greatest(${usageCounters.reservedValue} + ${delta.reserved ?? 0}, 0)`,
      measuredAt: now,
    })
    .where(
      and(eq(usageCounters.organizationId, organizationId), eq(usageCounters.category, category)),
    );
}
