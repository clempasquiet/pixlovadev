import Type, { type Static } from 'typebox';
import { Instant, Strict } from './common.js';

/**
 * Catalogue commercial (BILL-001, BILL-005, ADR-017). Les offres ne portent que des
 * capacités explicites : le code métier ne teste jamais le nom ou la clé d’une offre.
 * Les valeurs du cahier des charges sont indicatives tant qu’elles ne sont pas validées.
 */

/** Clé technique d’une offre, stable entre ses versions. */
export const PlanKey = Type.String({ pattern: '^[a-z][a-z0-9_-]{1,39}$' });

export const BillingInterval = Type.Union([Type.Literal('month'), Type.Literal('year')]);
export type BillingInterval = Static<typeof BillingInterval>;

export const BillingEnvironment = Type.Union([Type.Literal('test'), Type.Literal('live')]);
export type BillingEnvironment = Static<typeof BillingEnvironment>;

/** Code ISO 4217 en minuscules, comme chez Stripe. */
export const Currency = Type.String({ pattern: '^[a-z]{3}$' });

/** Montant en unité mineure (centimes), hors taxes. */
export const AmountMinor = Type.Integer({ minimum: 0, maximum: 100_000_000 });

/**
 * Fonctionnalités d’offre reconnues (matrice §24.3). Seules celles contrôlées par le
 * serveur en V1 figurent ici ; une clé inconnue est refusée à l’import du catalogue.
 */
export const PlanFeature = Type.Union([Type.Literal('templates')]);
export type PlanFeature = Static<typeof PlanFeature>;

/** Capacités d’une offre, hors slots de Displays portés par l’offre elle-même. */
export const PlanEntitlements = Type.Object(
  {
    max_users: Type.Integer({ minimum: 1, maximum: 100_000 }),
    /** Quota média en octets (ADR-009 : originaux, corbeille comprise). */
    storage_quota_bytes: Type.Integer({ minimum: 0, maximum: 1e15 }),
    features: Type.Array(PlanFeature, { uniqueItems: true, maxItems: 32 }),
  },
  { ...Strict, title: 'PlanEntitlements' },
);
export type PlanEntitlements = Static<typeof PlanEntitlements>;

export const PlanPrice = Type.Object(
  {
    interval: BillingInterval,
    currency: Currency,
    base_amount_minor: AmountMinor,
    /** Prix mensuel ou annuel d’un slot supplémentaire ; `null` : aucun extra. */
    extra_slot_amount_minor: Type.Union([AmountMinor, Type.Null()]),
  },
  Strict,
);

export const CatalogPlan = Type.Object(
  {
    key: PlanKey,
    version: Type.Integer({ minimum: 1 }),
    name: Type.String({ minLength: 1, maxLength: 80 }),
    /** Offre appliquée sans abonnement payant valide (BILL-003). */
    fallback: Type.Boolean(),
    included_display_slots: Type.Integer({ minimum: 0, maximum: 100_000 }),
    max_extra_display_slots: Type.Integer({ minimum: 0, maximum: 100_000 }),
    entitlements: PlanEntitlements,
    /** Montants et quotas non validés commercialement (§11.1) : à présenter comme indicatifs. */
    indicative: Type.Boolean(),
    prices: Type.Array(PlanPrice, { maxItems: 16 }),
  },
  Strict,
);

/**
 * Catalogue publié (`GET /api/v1/billing/catalog`) : réponse publique, sans identifiant
 * Stripe, consommée par le dashboard et le site commercial (L09-M).
 */
export const BillingCatalog = Type.Object(
  {
    environment: BillingEnvironment,
    /** Vrai si au moins une offre est indicative. */
    indicative: Type.Boolean(),
    plans: Type.Array(CatalogPlan, { maxItems: 32 }),
    generated_at: Instant,
  },
  { ...Strict, title: 'BillingCatalog' },
);
export type BillingCatalog = Static<typeof BillingCatalog>;

const StripePriceId = Type.String({ pattern: '^price_[A-Za-z0-9]{1,250}$' });

/** Prix d’une offre dans un environnement Stripe donné (fichier d’import). */
export const CatalogFilePrice = Type.Object(
  {
    environment: BillingEnvironment,
    interval: BillingInterval,
    currency: Currency,
    base_amount_minor: AmountMinor,
    extra_slot_amount_minor: Type.Optional(AmountMinor),
    /** Absent pour une offre gratuite ; sinon prix Stripe récurrent de la base. */
    base_stripe_price_id: Type.Optional(StripePriceId),
    /** Prix Stripe unitaire du slot supplémentaire. */
    extra_slot_stripe_price_id: Type.Optional(StripePriceId),
  },
  Strict,
);

/**
 * Fichier de catalogue importé par l’administration (`admin-cli catalog-import`). Chaque
 * offre dont le contenu change devient une nouvelle version publiée ; les versions
 * précédentes restent interprétables pour les abonnements existants (BILL-005).
 */
export const CatalogFile = Type.Object(
  {
    plans: Type.Array(
      Type.Object(
        {
          key: PlanKey,
          name: Type.String({ minLength: 1, maxLength: 80 }),
          fallback: Type.Optional(Type.Boolean()),
          sort_order: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
          included_display_slots: Type.Integer({ minimum: 0, maximum: 100_000 }),
          max_extra_display_slots: Type.Integer({ minimum: 0, maximum: 100_000 }),
          entitlements: PlanEntitlements,
          indicative: Type.Boolean(),
          prices: Type.Array(CatalogFilePrice, { maxItems: 16 }),
        },
        Strict,
      ),
      { minItems: 1, maxItems: 32 },
    ),
  },
  { ...Strict, title: 'CatalogFile' },
);
export type CatalogFile = Static<typeof CatalogFile>;
