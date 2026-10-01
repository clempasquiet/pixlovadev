import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, organizationId, tenantPolicy, updatedAt } from './common.js';
import { organizations, users } from './identity.js';

/** Environnement Stripe : les modes test et production ne partagent aucun objet (BILL-006). */
export const BILLING_ENVIRONMENTS = ['test', 'live'] as const;
export type BillingEnvironment = (typeof BILLING_ENVIRONMENTS)[number];

/** Statuts d’abonnement Stripe traités explicitement (BILL-015). */
export const STRIPE_SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;

export const BILLING_CHANGE_STATUSES = [
  'requested',
  'pending_payment',
  'applied',
  'failed',
  'cancelled',
  'expired',
  'scheduled',
] as const;

/**
 * Nature d’une demande (BILL-011, BILL-012, BILL-014) : première souscription, hausse
 * immédiate avec prorata, baisse ou annulation à l’échéance.
 */
export const BILLING_CHANGE_KINDS = ['subscribe', 'upgrade', 'downgrade', 'cancel'] as const;

/** Sélection des Displays conservés lors d’une baisse de capacité (BILL-012, BILL-014). */
export const DISPLAY_SELECTION_STATUSES = ['pending', 'applied', 'invalid'] as const;

const environmentCheck = (column: unknown) => sql`${column} in ('test', 'live')`;

/**
 * Offre versionnée du catalogue (BILL-001, BILL-005, ADR-017). Table globale, sans tenant.
 * Une version publiée n’est plus modifiée : un changement crée une nouvelle version, les
 * abonnements existants restent liés à la leur. Le code métier ne lit que les capacités
 * (`entitlements`, slots), jamais `key` ou `name`.
 */
export const plans = pgTable(
  'plans',
  {
    id: id(),
    /** Clé technique stable entre versions (sélection au Checkout, pas une condition métier). */
    key: text('key').notNull(),
    version: integer('version').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: ['draft', 'published', 'archived'] })
      .notNull()
      .default('draft'),
    /** Offre appliquée sans abonnement payant valide (BILL-003, BILL-014). */
    isFallback: boolean('is_fallback').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    includedDisplaySlots: integer('included_display_slots').notNull(),
    /** Slots supplémentaires achetables (BILL-002) ; nul : aucun extra. */
    maxExtraDisplaySlots: integer('max_extra_display_slots').notNull().default(0),
    /** Capacités typées validées par `@pixlova/billing` (max_users, stockage, fonctionnalités). */
    entitlements: jsonb('entitlements').notNull(),
    /** Valeurs commerciales non validées (§11.1) : affichées comme indicatives. */
    indicative: boolean('indicative').notNull().default(true),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('plans_key_version_unique').on(t.key, t.version),
    uniqueIndex('plans_one_published_version')
      .on(t.key)
      .where(sql`${t.status} = 'published'`),
    uniqueIndex('plans_one_published_fallback')
      .on(t.isFallback)
      .where(sql`${t.isFallback} and ${t.status} = 'published'`),
    check('plans_status_check', sql`${t.status} in ('draft', 'published', 'archived')`),
    check('plans_key_check', sql`${t.key} ~ '^[a-z][a-z0-9_-]{1,39}$'`),
    check('plans_version_check', sql`${t.version} >= 1`),
    check(
      'plans_slots_check',
      sql`${t.includedDisplaySlots} >= 0 and ${t.maxExtraDisplaySlots} >= 0`,
    ),
  ],
);

/**
 * Prix Stripe d’une version d’offre (DATA §16) : prix de base et prix unitaire du slot
 * supplémentaire distincts. Les montants servent à l’affichage et à la simulation ; Stripe
 * facture d’après ses propres prix, jamais d’après un montant venu du navigateur.
 */
export const planPrices = pgTable(
  'plan_prices',
  {
    id: id(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id),
    environment: text('environment', { enum: BILLING_ENVIRONMENTS }).notNull(),
    interval: text('interval', { enum: ['month', 'year'] }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    baseAmountMinor: integer('base_amount_minor').notNull(),
    extraSlotAmountMinor: integer('extra_slot_amount_minor'),
    baseStripePriceId: text('base_stripe_price_id'),
    extraSlotStripePriceId: text('extra_slot_stripe_price_id'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('plan_prices_plan_env_interval_currency_unique').on(
      t.planId,
      t.environment,
      t.interval,
      t.currency,
    ),
    uniqueIndex('plan_prices_base_price_unique')
      .on(t.environment, t.baseStripePriceId)
      .where(sql`${t.baseStripePriceId} is not null and ${t.active}`),
    check('plan_prices_environment_check', environmentCheck(t.environment)),
    check('plan_prices_interval_check', sql`${t.interval} in ('month', 'year')`),
    check('plan_prices_currency_check', sql`${t.currency} ~ '^[a-z]{3}$'`),
    check(
      'plan_prices_amounts_check',
      sql`${t.baseAmountMinor} >= 0 and coalesce(${t.extraSlotAmountMinor}, 0) >= 0`,
    ),
    check(
      'plan_prices_extra_check',
      sql`${t.extraSlotStripePriceId} is null or ${t.extraSlotAmountMinor} is not null`,
    ),
  ],
);

/** Client Stripe canonique d’une organisation, par environnement (BILL-006). */
export const billingCustomers = pgTable(
  'billing_customers',
  {
    id: id(),
    organizationId: organizationId(),
    environment: text('environment', { enum: BILLING_ENVIRONMENTS }).notNull(),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    /** État de la projection (BILL-009) : un retard ou une erreur reste visible et réparable. */
    syncStatus: text('sync_status', { enum: ['pending', 'ok', 'error'] })
      .notNull()
      .default('pending'),
    syncError: text('sync_error'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.organizationId], foreignColumns: [organizations.id] }),
    unique('billing_customers_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('billing_customers_org_env_unique').on(t.organizationId, t.environment),
    uniqueIndex('billing_customers_stripe_unique').on(t.environment, t.stripeCustomerId),
    check('billing_customers_environment_check', environmentCheck(t.environment)),
    check('billing_customers_sync_check', sql`${t.syncStatus} in ('pending', 'ok', 'error')`),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/**
 * Projection locale vérifiée d’un abonnement Stripe (BILL-009). Écrite uniquement par la
 * synchronisation (rôle système), à partir de l’état relu chez Stripe. Base et slots
 * supplémentaires sont les deux lignes d’abonnement connues (`*_item_id`).
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: id(),
    organizationId: organizationId(),
    environment: text('environment', { enum: BILLING_ENVIRONMENTS }).notNull(),
    billingCustomerId: uuid('billing_customer_id').notNull(),
    stripeSubscriptionId: text('stripe_subscription_id').notNull(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id),
    planPriceId: uuid('plan_price_id')
      .notNull()
      .references(() => planPrices.id),
    stripeStatus: text('stripe_status', { enum: STRIPE_SUBSCRIPTION_STATUSES }).notNull(),
    extraDisplaySlots: integer('extra_display_slots').notNull().default(0),
    stripeBaseItemId: text('stripe_base_item_id'),
    stripeExtraItemId: text('stripe_extra_item_id'),
    stripeCreatedAt: timestamp('stripe_created_at', { withTimezone: true }).notNull(),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** Fin de la période de grâce d’un impayé (BILL-015, durée à valider). */
    graceUntil: timestamp('grace_until', { withTimezone: true }),
    /** Planification Stripe portant une baisse à l’échéance (BILL-012). */
    stripeScheduleId: text('stripe_schedule_id'),
    /** Hausse en attente de paiement (`pending_update` Stripe) : droits inchangés. */
    pendingUpdate: boolean('pending_update').notNull().default(false),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'subscriptions_customer_same_tenant_fk',
      columns: [t.organizationId, t.billingCustomerId],
      foreignColumns: [billingCustomers.organizationId, billingCustomers.id],
    }),
    unique('subscriptions_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('subscriptions_stripe_unique').on(t.environment, t.stripeSubscriptionId),
    index('subscriptions_org_idx').on(t.organizationId, t.environment),
    check('subscriptions_environment_check', environmentCheck(t.environment)),
    check(
      'subscriptions_status_check',
      sql`${t.stripeStatus} in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')`,
    ),
    check('subscriptions_extra_check', sql`${t.extraDisplaySlots} >= 0`),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/**
 * Demande commerciale suivie (BILL-008, BILL-011) : enregistrée avant l’appel Stripe, sous
 * une clé d’idempotence durable. Aucun droit payant n’est accordé sur le retour navigateur :
 * seule la projection relue chez Stripe fait passer la demande à `applied`.
 */
export const billingChanges = pgTable(
  'billing_changes',
  {
    id: id(),
    organizationId: organizationId(),
    environment: text('environment', { enum: BILLING_ENVIRONMENTS }).notNull(),
    kind: text('kind', { enum: BILLING_CHANGE_KINDS }).notNull(),
    status: text('status', { enum: BILLING_CHANGE_STATUSES }).notNull().default('requested'),
    requestedBy: uuid('requested_by').references(() => users.id),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    /** Offre visée ; `null` pour une annulation (retour à l’offre de repli). */
    planId: uuid('plan_id').references(() => plans.id),
    planPriceId: uuid('plan_price_id').references(() => planPrices.id),
    extraDisplaySlots: integer('extra_display_slots').notNull().default(0),
    /** Abonnement modifié (hausse, baisse, annulation). */
    subscriptionId: uuid('subscription_id'),
    /** Date d’effet : immédiate pour une hausse, fin de période sinon. */
    effectiveAt: timestamp('effective_at', { withTimezone: true }),
    /** Date de prorata transmise à Stripe, identique à celle de la prévisualisation. */
    prorationDate: timestamp('proration_date', { withTimezone: true }),
    stripeScheduleId: text('stripe_schedule_id'),
    /** Displays à conserver actifs à l’échéance, choisis explicitement (BILL-012). */
    keepDisplayIds: uuid('keep_display_ids').array(),
    selectionStatus: text('selection_status', { enum: DISPLAY_SELECTION_STATUSES }),
    stripeCheckoutSessionId: text('stripe_checkout_session_id'),
    checkoutUrl: text('checkout_url'),
    checkoutExpiresAt: timestamp('checkout_expires_at', { withTimezone: true }),
    stripeSubscriptionId: text('stripe_subscription_id'),
    failureReason: text('failure_reason'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.organizationId], foreignColumns: [organizations.id] }),
    unique('billing_changes_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('billing_changes_idempotency_unique').on(t.organizationId, t.idempotencyKey),
    // Double clic ou deux onglets : une seule souscription en cours par organisation.
    uniqueIndex('billing_changes_one_open_subscribe')
      .on(t.organizationId, t.environment)
      .where(sql`${t.kind} = 'subscribe' and ${t.status} in ('requested', 'pending_payment')`),
    // Une seule modification d’abonnement en cours par organisation (BILL-011, BILL-012).
    uniqueIndex('billing_changes_one_open_change')
      .on(t.organizationId, t.environment)
      .where(
        sql`${t.kind} <> 'subscribe' and ${t.status} in ('requested', 'pending_payment', 'scheduled')`,
      ),
    foreignKey({
      name: 'billing_changes_subscription_same_tenant_fk',
      columns: [t.organizationId, t.subscriptionId],
      foreignColumns: [subscriptions.organizationId, subscriptions.id],
    }),
    uniqueIndex('billing_changes_checkout_unique')
      .on(t.stripeCheckoutSessionId)
      .where(sql`${t.stripeCheckoutSessionId} is not null`),
    check('billing_changes_environment_check', environmentCheck(t.environment)),
    check(
      'billing_changes_kind_check',
      sql`${t.kind} in ('subscribe', 'upgrade', 'downgrade', 'cancel')`,
    ),
    check(
      'billing_changes_status_check',
      sql`${t.status} in ('requested', 'pending_payment', 'applied', 'failed', 'cancelled', 'expired', 'scheduled')`,
    ),
    check(
      'billing_changes_plan_check',
      sql`(${t.kind} = 'cancel') = (${t.planId} is null and ${t.planPriceId} is null)`,
    ),
    check(
      'billing_changes_subscription_check',
      sql`${t.kind} = 'subscribe' or ${t.subscriptionId} is not null`,
    ),
    check(
      'billing_changes_selection_check',
      sql`${t.selectionStatus} is null or ${t.selectionStatus} in ('pending', 'applied', 'invalid')`,
    ),
    check('billing_changes_extra_check', sql`${t.extraDisplaySlots} >= 0`),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/**
 * Journal des événements Stripe reçus (BILL-010) : signature vérifiée, stockage durable
 * avant réponse, déduplication par (environnement, identifiant). Sans tenant : accessible
 * au seul rôle système. Le contenu est effacé après la rétention (sweep du worker).
 */
export const stripeWebhookEvents = pgTable(
  'stripe_webhook_events',
  {
    id: id(),
    environment: text('environment', { enum: BILLING_ENVIRONMENTS }).notNull(),
    stripeEventId: text('stripe_event_id').notNull(),
    type: text('type').notNull(),
    apiVersion: text('api_version'),
    objectId: text('object_id'),
    stripeCustomerId: text('stripe_customer_id'),
    stripeCreatedAt: timestamp('stripe_created_at', { withTimezone: true }).notNull(),
    payload: jsonb('payload'),
    status: text('status', { enum: ['received', 'processed', 'ignored', 'failed'] })
      .notNull()
      .default('received'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('stripe_event_unique').on(t.environment, t.stripeEventId),
    index('stripe_webhook_events_received_idx').on(t.receivedAt),
    check('stripe_webhook_events_environment_check', environmentCheck(t.environment)),
    check(
      'stripe_webhook_events_status_check',
      sql`${t.status} in ('received', 'processed', 'ignored', 'failed')`,
    ),
  ],
);

/**
 * Réductions effectivement appliquées (BILL-017, BILL-019), relevées sur l’abonnement
 * Stripe : code, coupon, durée et acteur si connu ; origine système sinon, jamais inventée.
 */
export const promotionRedemptions = pgTable(
  'promotion_redemptions',
  {
    id: id(),
    organizationId: organizationId(),
    environment: text('environment', { enum: BILLING_ENVIRONMENTS }).notNull(),
    subscriptionId: uuid('subscription_id').notNull(),
    billingChangeId: uuid('billing_change_id'),
    stripeDiscountId: text('stripe_discount_id').notNull(),
    stripeCouponId: text('stripe_coupon_id'),
    stripePromotionCodeId: text('stripe_promotion_code_id'),
    codeSnapshot: text('code_snapshot'),
    percentOff: numeric('percent_off', { precision: 5, scale: 2 }),
    amountOffMinor: integer('amount_off_minor'),
    currency: char('currency', { length: 3 }),
    duration: text('duration'),
    durationInMonths: integer('duration_in_months'),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    appliedBy: uuid('applied_by').references(() => users.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'promotion_redemptions_subscription_same_tenant_fk',
      columns: [t.organizationId, t.subscriptionId],
      foreignColumns: [subscriptions.organizationId, subscriptions.id],
    }),
    foreignKey({
      name: 'promotion_redemptions_change_same_tenant_fk',
      columns: [t.organizationId, t.billingChangeId],
      foreignColumns: [billingChanges.organizationId, billingChanges.id],
    }),
    uniqueIndex('promotion_redemptions_discount_unique').on(t.environment, t.stripeDiscountId),
    check('promotion_redemptions_environment_check', environmentCheck(t.environment)),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();
