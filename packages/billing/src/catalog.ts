import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  canonicalJson,
  describeErrors,
  validator,
  type BillingCatalog,
  type BillingEnvironment,
  type CatalogFile,
  type PlanEntitlements,
} from '@pixlova/contracts';
import { schema, type Database, type Transaction } from '@pixlova/db';
import { BUILTIN_FALLBACK_PLAN, type PlanCapacities } from './entitlements.js';

type PlanRow = typeof schema.plans.$inferSelect;
type PriceRow = typeof schema.planPrices.$inferSelect;

export function capacitiesOf(plan: PlanRow): PlanCapacities {
  return {
    planId: plan.id,
    key: plan.key,
    version: plan.version,
    name: plan.name,
    includedDisplaySlots: plan.includedDisplaySlots,
    maxExtraDisplaySlots: plan.maxExtraDisplaySlots,
    entitlements: plan.entitlements as PlanEntitlements,
  };
}

/** Offre de repli publiée, ou l’offre gratuite intégrée si le catalogue n’en publie pas. */
export async function fallbackPlan(db: Database | Transaction): Promise<PlanCapacities> {
  const [plan] = await db
    .select()
    .from(schema.plans)
    .where(and(eq(schema.plans.isFallback, true), eq(schema.plans.status, 'published')));
  return plan ? capacitiesOf(plan) : BUILTIN_FALLBACK_PLAN;
}

/** Catalogue publié d’un environnement (`GET /billing/catalog`) : aucun identifiant Stripe. */
export async function publishedCatalog(
  db: Database | Transaction,
  environment: BillingEnvironment,
  now: Date,
): Promise<BillingCatalog> {
  const plans = await db
    .select()
    .from(schema.plans)
    .where(eq(schema.plans.status, 'published'))
    .orderBy(asc(schema.plans.sortOrder), asc(schema.plans.key));
  const prices = plans.length
    ? await db
        .select()
        .from(schema.planPrices)
        .where(
          and(
            inArray(
              schema.planPrices.planId,
              plans.map((p) => p.id),
            ),
            eq(schema.planPrices.environment, environment),
            eq(schema.planPrices.active, true),
          ),
        )
        .orderBy(asc(schema.planPrices.interval), asc(schema.planPrices.currency))
    : [];
  const items = plans.map((plan) => ({
    key: plan.key,
    version: plan.version,
    name: plan.name,
    fallback: plan.isFallback,
    included_display_slots: plan.includedDisplaySlots,
    max_extra_display_slots: plan.maxExtraDisplaySlots,
    entitlements: plan.entitlements as PlanEntitlements,
    indicative: plan.indicative,
    prices: prices
      .filter((price) => price.planId === plan.id)
      .map((price) => ({
        interval: price.interval,
        currency: price.currency,
        base_amount_minor: price.baseAmountMinor,
        extra_slot_amount_minor: price.extraSlotAmountMinor,
      })),
  }));
  return {
    environment,
    indicative: items.some((plan) => plan.indicative),
    plans: items,
    generated_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

/** Prix achetable : offre publiée, prix actif de l’environnement, prix Stripe de base connu. */
export async function purchasablePrice(
  db: Database | Transaction,
  input: { planKey: string; interval: 'month' | 'year'; environment: BillingEnvironment },
): Promise<{ plan: PlanRow; price: PriceRow } | null> {
  const [row] = await db
    .select({ plan: schema.plans, price: schema.planPrices })
    .from(schema.plans)
    .innerJoin(schema.planPrices, eq(schema.planPrices.planId, schema.plans.id))
    .where(
      and(
        eq(schema.plans.key, input.planKey),
        eq(schema.plans.status, 'published'),
        eq(schema.planPrices.environment, input.environment),
        eq(schema.planPrices.interval, input.interval),
        eq(schema.planPrices.active, true),
        sql`${schema.planPrices.baseStripePriceId} is not null`,
      ),
    )
    .orderBy(asc(schema.planPrices.currency))
    .limit(1);
  return row ?? null;
}

export class CatalogError extends Error {
  override readonly name = 'CatalogError';
}

/** Valide un fichier de catalogue (schéma partagé et règles de cohérence). */
export function parseCatalogFile(input: unknown): CatalogFile {
  const validate = validator('billing-catalog-file.json');
  if (!validate(input))
    throw new CatalogError(`Catalogue invalide : ${describeErrors(validate.errors)}`);
  const file = input as CatalogFile;
  const keys = new Set<string>();
  let fallbacks = 0;
  for (const plan of file.plans) {
    if (keys.has(plan.key)) throw new CatalogError(`Offre en double : ${plan.key}`);
    keys.add(plan.key);
    if (plan.fallback) {
      fallbacks += 1;
      if (plan.prices.some((p) => p.base_stripe_price_id || p.base_amount_minor > 0)) {
        throw new CatalogError(`L’offre de repli ${plan.key} ne peut pas être payante.`);
      }
      if (plan.max_extra_display_slots > 0) {
        throw new CatalogError(`L’offre de repli ${plan.key} ne vend pas de slot supplémentaire.`);
      }
    }
    const seen = new Set<string>();
    for (const price of plan.prices) {
      const id = `${price.environment}/${price.interval}/${price.currency}`;
      if (seen.has(id)) throw new CatalogError(`Prix en double pour ${plan.key} : ${id}`);
      seen.add(id);
      const extra = price.extra_slot_amount_minor !== undefined;
      if (extra !== plan.max_extra_display_slots > 0) {
        throw new CatalogError(
          `${plan.key} ${id} : un montant de slot supplémentaire est requis si et seulement si l’offre en vend.`,
        );
      }
      if (price.extra_slot_stripe_price_id && !extra) {
        throw new CatalogError(`${plan.key} ${id} : prix Stripe de slot sans montant.`);
      }
      // Sans prix Stripe, l’offre est affichée (catalogue indicatif) mais pas achetable.
      if (price.base_stripe_price_id && extra && !price.extra_slot_stripe_price_id) {
        throw new CatalogError(`${plan.key} ${id} : prix Stripe du slot supplémentaire requis.`);
      }
      if (!price.base_stripe_price_id && price.extra_slot_stripe_price_id) {
        throw new CatalogError(`${plan.key} ${id} : prix Stripe de base requis.`);
      }
    }
  }
  if (fallbacks > 1) throw new CatalogError('Une seule offre de repli est autorisée.');
  return file;
}

function planFingerprint(plan: CatalogFile['plans'][number]): string {
  return canonicalJson({
    name: plan.name,
    fallback: plan.fallback ?? false,
    sort_order: plan.sort_order ?? 0,
    included_display_slots: plan.included_display_slots,
    max_extra_display_slots: plan.max_extra_display_slots,
    entitlements: { ...plan.entitlements, features: [...plan.entitlements.features].sort() },
    indicative: plan.indicative,
    prices: [...plan.prices]
      .map((p) => ({ extra_slot_amount_minor: null, ...p }))
      .map((p) => ({
        ...p,
        base_stripe_price_id: p.base_stripe_price_id ?? null,
        extra_slot_stripe_price_id: p.extra_slot_stripe_price_id ?? null,
      }))
      .sort((a, b) =>
        `${a.environment}${a.interval}${a.currency}`.localeCompare(
          `${b.environment}${b.interval}${b.currency}`,
        ),
      ),
  });
}

async function storedFingerprint(tx: Transaction, plan: PlanRow): Promise<string> {
  const prices = await tx
    .select()
    .from(schema.planPrices)
    .where(and(eq(schema.planPrices.planId, plan.id), eq(schema.planPrices.active, true)));
  return planFingerprint({
    key: plan.key,
    name: plan.name,
    fallback: plan.isFallback,
    sort_order: plan.sortOrder,
    included_display_slots: plan.includedDisplaySlots,
    max_extra_display_slots: plan.maxExtraDisplaySlots,
    entitlements: plan.entitlements as PlanEntitlements,
    indicative: plan.indicative,
    prices: prices.map((p) => ({
      environment: p.environment,
      interval: p.interval,
      currency: p.currency,
      base_amount_minor: p.baseAmountMinor,
      ...(p.extraSlotAmountMinor !== null
        ? { extra_slot_amount_minor: p.extraSlotAmountMinor }
        : {}),
      ...(p.baseStripePriceId ? { base_stripe_price_id: p.baseStripePriceId } : {}),
      ...(p.extraSlotStripePriceId ? { extra_slot_stripe_price_id: p.extraSlotStripePriceId } : {}),
    })),
  });
}

export interface ImportResult {
  published: { key: string; version: number }[];
  unchanged: string[];
  archived: string[];
}

/**
 * Publie un catalogue (ADM-005) dans une transaction : toute offre modifiée devient une
 * nouvelle version publiée, l’ancienne est archivée mais reste liée aux abonnements qui la
 * référencent (BILL-005). Une offre absente du fichier est archivée (plus vendue). Aucune
 * version publiée n’est réécrite.
 */
export async function importCatalog(
  tx: Transaction,
  file: CatalogFile,
  now: Date,
): Promise<ImportResult> {
  const result: ImportResult = { published: [], unchanged: [], archived: [] };
  // Deux publications simultanées sont sérialisées (verrou consultatif de transaction).
  await tx.execute(sql`select pg_advisory_xact_lock(727602)`);
  const current = await tx.select().from(schema.plans).where(eq(schema.plans.status, 'published'));
  const byKey = new Map(current.map((plan) => [plan.key, plan]));
  for (const plan of file.plans) {
    const existing = byKey.get(plan.key);
    if (existing && (await storedFingerprint(tx, existing)) === planFingerprint(plan)) {
      result.unchanged.push(plan.key);
      continue;
    }
  }
  // Archiver d’abord : l’unicité « une version publiée par clé » et « une offre de repli ».
  const toArchive = current.filter((plan) => !result.unchanged.includes(plan.key));
  for (const plan of toArchive) {
    // Les prix de la version archivée ne sont plus vendus ; les abonnements existants
    // restent rattachés à leur version (projection).
    await tx.update(schema.plans).set({ status: 'archived' }).where(eq(schema.plans.id, plan.id));
    await tx
      .update(schema.planPrices)
      .set({ active: false })
      .where(eq(schema.planPrices.planId, plan.id));
    if (!file.plans.some((p) => p.key === plan.key)) result.archived.push(plan.key);
  }
  for (const plan of file.plans) {
    if (result.unchanged.includes(plan.key)) continue;
    const [last] = await tx
      .select({ version: sql<number>`coalesce(max(${schema.plans.version}), 0)::int` })
      .from(schema.plans)
      .where(eq(schema.plans.key, plan.key));
    const version = (last?.version ?? 0) + 1;
    const [created] = await tx
      .insert(schema.plans)
      .values({
        key: plan.key,
        version,
        name: plan.name,
        status: 'published',
        isFallback: plan.fallback ?? false,
        sortOrder: plan.sort_order ?? 0,
        includedDisplaySlots: plan.included_display_slots,
        maxExtraDisplaySlots: plan.max_extra_display_slots,
        entitlements: plan.entitlements,
        indicative: plan.indicative,
        publishedAt: now,
      })
      .returning({ id: schema.plans.id });
    if (plan.prices.length) {
      await tx.insert(schema.planPrices).values(
        plan.prices.map((price) => ({
          planId: created!.id,
          environment: price.environment,
          interval: price.interval,
          currency: price.currency,
          baseAmountMinor: price.base_amount_minor,
          extraSlotAmountMinor: price.extra_slot_amount_minor ?? null,
          baseStripePriceId: price.base_stripe_price_id ?? null,
          extraSlotStripePriceId: price.extra_slot_stripe_price_id ?? null,
        })),
      );
    }
    result.published.push({ key: plan.key, version });
  }
  return result;
}
