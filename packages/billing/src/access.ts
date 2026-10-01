import { and, desc, eq, sql } from 'drizzle-orm';
import type { BillingEnvironment } from '@pixlova/contracts';
import { schema, type Transaction } from '@pixlova/db';
import { capacitiesOf, fallbackPlan } from './catalog.js';
import {
  effectiveEntitlements,
  LIVE_STATUSES,
  type EffectiveEntitlements,
} from './entitlements.js';

export interface OrganizationBilling {
  effective: EffectiveEntitlements;
  /** Abonnement courant (statut Stripe vivant), ou le plus récent s’il n’y en a pas. */
  subscription: typeof schema.subscriptions.$inferSelect | null;
}

/**
 * Droits effectifs lus dans la projection locale (BILL-009), sous la transaction fournie
 * (contexte tenant ou rôle de lecture inter-tenants). Aucun appel Stripe.
 */
export async function organizationBilling(
  tx: Transaction,
  organizationId: string,
  environment: BillingEnvironment,
  now: Date,
): Promise<OrganizationBilling> {
  const fallback = await fallbackPlan(tx);
  const rows = await tx
    .select({ subscription: schema.subscriptions, plan: schema.plans })
    .from(schema.subscriptions)
    .innerJoin(schema.plans, eq(schema.plans.id, schema.subscriptions.planId))
    .where(
      and(
        eq(schema.subscriptions.organizationId, organizationId),
        eq(schema.subscriptions.environment, environment),
      ),
    )
    .orderBy(desc(schema.subscriptions.stripeCreatedAt));
  // Le plus récent des abonnements vivants ; jamais un abonnement terminé quand un autre vit.
  const live = rows.find((row) => LIVE_STATUSES.has(row.subscription.stripeStatus));
  const effective = effectiveEntitlements(
    fallback,
    live ? { subscription: live.subscription, plan: capacitiesOf(live.plan) } : null,
    now,
  );
  return { effective, subscription: (live ?? rows[0])?.subscription ?? null };
}

export interface OrganizationUsage {
  activeDisplays: number;
  /** Membres actifs et invitations en attente (ADR-007). */
  users: number;
  /** Octets comptés et réservés (ADR-009). */
  storageBytes: number;
}

/** Utilisation comptée contre les droits (BILL-004), selon les règles des contrôles de quota. */
export async function organizationUsage(
  tx: Transaction,
  organizationId: string,
  now: Date,
): Promise<OrganizationUsage> {
  const result = await tx.execute<{ displays: number; users: number; storage: string | null }>(sql`
    select
      (select count(*)::int from displays
        where organization_id = ${organizationId} and lifecycle_status = 'active'
          and deleted_at is null) as displays,
      (select count(*)::int from memberships
        where organization_id = ${organizationId} and status = 'active')
      + (select count(*)::int from invitations
        where organization_id = ${organizationId} and accepted_at is null
          and revoked_at is null and expires_at > ${now.toISOString()}::timestamptz) as users,
      (select observed_value + reserved_value from usage_counters
        where organization_id = ${organizationId} and category = 'storage_bytes') as storage`);
  const row = result.rows[0];
  return {
    activeDisplays: Number(row?.displays ?? 0),
    users: Number(row?.users ?? 0),
    storageBytes: Number(row?.storage ?? 0),
  };
}
