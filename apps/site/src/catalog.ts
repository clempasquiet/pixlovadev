/**
 * Catalogue affiché par le site (WEB-001, WEB-003, BILL-003, BILL-004).
 *
 * Tant que L08 ne publie pas de catalogue contrôlé, le site affiche les prix **indicatifs**
 * du cahier des charges (§ 11.2) avec la mention correspondante. Le remplacement par la
 * publication L08 ne doit changer que la source de `SITE_CATALOG`, pas les pages.
 * Essai gratuit et remise annuelle restent des propositions : ils ne sont pas affichés.
 */

export type CatalogStatus = 'indicative' | 'published';

export interface PlanOffer {
  readonly key: string;
  readonly name: string;
  readonly audience: string;
  /** Base mensuelle hors taxes, en centimes. */
  readonly monthlyBaseCents: number;
  readonly includedDisplays: number;
  /** Prix mensuel HT d’un écran supplémentaire, en centimes ; `null` si non prévu. */
  readonly extraDisplayCents: number | null;
  readonly storageGb: number;
  /** Nombre d’utilisateurs ; `null` tant que la valeur reste à fixer. */
  readonly users: number | null;
}

export interface Catalog {
  readonly status: CatalogStatus;
  readonly currency: 'EUR';
  readonly plans: readonly PlanOffer[];
}

export const SITE_CATALOG: Catalog = {
  status: 'indicative',
  currency: 'EUR',
  plans: [
    {
      key: 'free',
      name: 'Free',
      audience: 'Pour essayer',
      monthlyBaseCents: 0,
      includedDisplays: 1,
      extraDisplayCents: null,
      storageGb: 2,
      users: 1,
    },
    {
      key: 'pro',
      name: 'Pro',
      audience: 'Commerces et petits réseaux',
      monthlyBaseCents: 3900,
      includedDisplays: 10,
      extraDisplayCents: 400,
      storageGb: 100,
      users: 10,
    },
    {
      key: 'business',
      name: 'Business',
      audience: 'Réseaux de lieux',
      monthlyBaseCents: 9900,
      includedDisplays: 30,
      extraDisplayCents: 300,
      storageGb: 500,
      users: null,
    },
  ],
};

export interface Quote {
  readonly plan: PlanOffer;
  readonly displays: number;
  readonly extraDisplays: number;
  readonly totalCents: number;
}

/** Coût mensuel HT d’une offre pour un nombre d’écrans ; `null` si l’offre ne le permet pas. */
export function quote(plan: PlanOffer, displays: number): Quote | null {
  if (!Number.isInteger(displays) || displays < 1) return null;
  const extraDisplays = Math.max(0, displays - plan.includedDisplays);
  if (extraDisplays > 0 && plan.extraDisplayCents === null) return null;
  return {
    plan,
    displays,
    extraDisplays,
    totalCents: plan.monthlyBaseCents + extraDisplays * (plan.extraDisplayCents ?? 0),
  };
}

/** Offre la moins chère pour ce nombre d’écrans ; à égalité, la première du catalogue. */
export function cheapestQuote(catalog: Catalog, displays: number): Quote | null {
  let best: Quote | null = null;
  for (const plan of catalog.plans) {
    const q = quote(plan, displays);
    if (q && (best === null || q.totalCents < best.totalCents)) best = q;
  }
  return best;
}

export function euros(cents: number): string {
  const value = cents / 100;
  return `${Number.isInteger(value) ? value : value.toFixed(2).replace('.', ',')} €`;
}

/** Détail lisible du calcul, par exemple « 39 € + (14 − 10) × 4 € = 55 € HT / mois ». */
export function formula(q: Quote): string {
  if (q.totalCents === 0) return 'Gratuit, sans carte bancaire';
  const base = euros(q.plan.monthlyBaseCents);
  const total = `${euros(q.totalCents)} HT / mois`;
  if (q.extraDisplays === 0 || q.plan.extraDisplayCents === null) return total;
  return `${base} + (${q.displays} − ${q.plan.includedDisplays}) × ${euros(q.plan.extraDisplayCents)} = ${total}`;
}
