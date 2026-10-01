import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, idempotencyKey } from '../api.js';
import { useLoad } from '../data.js';
import { useSession } from '../session.js';
import { ErrorMessage, Forbidden, Loading } from '../ui.js';

/** Page Abonnement (ADR-017) : état, capacités, souscription, changements et annulation. */

interface PlanRef {
  key: string;
  version: number;
  name: string;
}

interface Change {
  id: string;
  kind: 'subscribe' | 'upgrade' | 'downgrade' | 'cancel';
  status: string;
  plan_id: string | null;
  extra_display_slots: number;
  effective_at: string | null;
  keep_display_ids: string[] | null;
  selection_status: 'pending' | 'applied' | 'invalid' | null;
  checkout_url: string | null;
  failure_reason: string | null;
  applied_at: string | null;
}

interface SubscriptionView {
  state: 'free' | 'active' | 'grace' | 'restricted' | 'pending';
  plan: PlanRef;
  subscribed_plan: PlanRef | null;
  subscription: {
    status: string;
    interval: string | null;
    currency: string | null;
    base_amount_minor: number | null;
    extra_slot_amount_minor: number | null;
    extra_display_slots: number;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    pending_update: boolean;
    grace_until: string | null;
  } | null;
  display_slots: {
    included: number;
    extra: number;
    total: number;
    active: number;
    available: number;
    over_capacity: boolean;
  };
  users: { allowed: number; used: number };
  storage: { allowed_bytes: number; used_bytes: number };
  features: string[];
  sync: { status: 'pending' | 'ok' | 'error'; last_synced_at: string | null } | null;
  open_changes: Change[];
  purchase_available: boolean;
}

interface CatalogPlan {
  key: string;
  version: number;
  name: string;
  fallback: boolean;
  included_display_slots: number;
  max_extra_display_slots: number;
  entitlements: { max_users: number; storage_quota_bytes: number; features: string[] };
  indicative: boolean;
  prices: {
    interval: 'month' | 'year';
    currency: string;
    base_amount_minor: number;
    extra_slot_amount_minor: number | null;
  }[];
}

interface Preview {
  kind: 'upgrade' | 'downgrade';
  plan: PlanRef;
  currency: string;
  extra_display_slots: number;
  current_amount_minor: number;
  new_amount_minor: number;
  amount_due_now_minor: number;
  proration_date: string | null;
  effective_at: string | null;
  next_period_end: string | null;
  capacity: { display_slots: number; active_displays: number; selection_required: boolean };
  warnings: { code: string; allowed: number; used: number }[];
  indicative: boolean;
}

interface DisplayItem {
  id: string;
  name: string;
  lifecycle_status: string;
}

const STATE_LABEL: Record<SubscriptionView['state'], string> = {
  free: 'Offre gratuite',
  active: 'Abonnement actif',
  grace: 'Paiement en retard : droits maintenus pendant la période de grâce',
  restricted: 'Paiement non régularisé : droits réduits, données conservées',
  pending: 'Paiement en attente de confirmation',
};

const WARNING_LABEL: Record<string, string> = {
  USERS_OVER_LIMIT: 'utilisateurs',
  STORAGE_OVER_LIMIT: 'stockage',
};

function money(amountMinor: number | null, currency = 'eur'): string {
  if (amountMinor === null) return '—';
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amountMinor / 100);
}

function date(value: string | null): string {
  return value ? new Date(value).toLocaleDateString('fr-FR', { dateStyle: 'long' }) : '—';
}

function bytes(value: number): string {
  if (value >= 1e9)
    return `${(value / 1e9).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Go`;
  return `${(value / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 0 })} Mo`;
}

/** Choix explicite des Displays conservés (BILL-012, BILL-014) : jamais au hasard. */
function DisplaySelection(props: {
  capacity: number;
  selected: string[];
  onChange(ids: string[]): void;
}) {
  const displays = useLoad<{ items: DisplayItem[] }>('/displays');
  const active = displays.data?.items.filter((d) => d.lifecycle_status === 'active') ?? [];
  if (!displays.data) return <Loading label="Chargement des écrans…" />;
  const toggle = (id: string) =>
    props.onChange(
      props.selected.includes(id)
        ? props.selected.filter((value) => value !== id)
        : [...props.selected, id],
    );
  return (
    <fieldset>
      <legend>
        Écrans à garder actifs ({props.selected.length} / {props.capacity})
      </legend>
      <p className="hint">
        Les autres écrans deviendront inactifs à l’échéance : ils ne diffusent plus, mais leur
        programmation, leurs contenus et leur historique sont conservés.
      </p>
      {active.map((display) => (
        <div key={display.id}>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={props.selected.includes(display.id)}
              disabled={
                !props.selected.includes(display.id) && props.selected.length >= props.capacity
              }
              onChange={() => toggle(display.id)}
            />
            {display.name}
          </label>
        </div>
      ))}
    </fieldset>
  );
}

function SubscribeForm({ catalog }: { catalog: CatalogPlan[] }) {
  const paid = catalog.filter((plan) => !plan.fallback && plan.prices.length > 0);
  const [planKey, setPlanKey] = useState(paid[0]?.key ?? '');
  const [extra, setExtra] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const plan = paid.find((p) => p.key === planKey);
  const price = plan?.prices.find((p) => p.interval === 'month');
  if (!plan || !price) return null;
  const total = price.base_amount_minor + extra * (price.extra_slot_amount_minor ?? 0);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        try {
          const change = await api<Change>(
            'POST',
            '/billing/checkout-session',
            { plan_key: planKey, interval: 'month', extra_display_slots: extra },
            idempotencyKey(),
          );
          if (change.checkout_url) window.location.assign(change.checkout_url);
        } catch (caught) {
          setError(caught);
          setPending(false);
        }
      }}
    >
      <div className="field">
        <label htmlFor="plan">Offre</label>
        <select id="plan" value={planKey} onChange={(e) => setPlanKey(e.target.value)}>
          {paid.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name} · {p.included_display_slots} écrans inclus
            </option>
          ))}
        </select>
      </div>
      {price.extra_slot_amount_minor !== null && (
        <div className="field">
          <label htmlFor="extra">Écrans supplémentaires</label>
          <input
            id="extra"
            type="number"
            min={0}
            max={plan.max_extra_display_slots}
            value={extra}
            onChange={(e) => setExtra(Math.max(0, Number(e.target.value) || 0))}
          />
        </div>
      )}
      <p>
        {plan.included_display_slots + extra} écrans · {money(total, price.currency)} par mois hors
        taxes
        {plan.indicative && <span className="muted"> (tarif indicatif)</span>}
      </p>
      <ErrorMessage error={error} />
      <button type="submit" disabled={pending}>
        {pending ? 'Redirection…' : 'Souscrire'}
      </button>
    </form>
  );
}

function ChangeForm(props: {
  catalog: CatalogPlan[];
  view: SubscriptionView;
  onDone(): Promise<void>;
}) {
  const paid = props.catalog.filter((plan) => !plan.fallback && plan.prices.length > 0);
  const [planKey, setPlanKey] = useState(props.view.plan.key);
  const [extra, setExtra] = useState(props.view.subscription?.extra_display_slots ?? 0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [keep, setKeep] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const body = { plan_key: planKey, interval: 'month', extra_display_slots: extra };
  async function run(action: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }
  return (
    <div>
      <div className="field">
        <label htmlFor="change-plan">Nouvelle offre</label>
        <select
          id="change-plan"
          value={planKey}
          onChange={(e) => {
            setPlanKey(e.target.value);
            setPreview(null);
          }}
        >
          {paid.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name} · {p.included_display_slots} écrans inclus
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="change-extra">Écrans supplémentaires</label>
        <input
          id="change-extra"
          type="number"
          min={0}
          value={extra}
          onChange={(e) => {
            setExtra(Math.max(0, Number(e.target.value) || 0));
            setPreview(null);
          }}
        />
      </div>
      {!preview && (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            run(async () =>
              setPreview(await api<Preview>('POST', '/billing/subscription/preview', body)),
            )
          }
        >
          Voir le détail
        </button>
      )}
      {preview && (
        <div className="card">
          <p>
            Nouveau montant : <strong>{money(preview.new_amount_minor, preview.currency)}</strong>{' '}
            par mois hors taxes (actuellement{' '}
            {money(preview.current_amount_minor, preview.currency)})
            {preview.indicative && <span className="muted"> · tarif indicatif</span>}
          </p>
          {preview.kind === 'upgrade' ? (
            <p>
              Effet immédiat. Montant facturé maintenant au prorata :{' '}
              <strong>{money(preview.amount_due_now_minor, preview.currency)}</strong>. Prochaine
              échéance : {date(preview.next_period_end)}.
            </p>
          ) : (
            <p>
              Effet à l’échéance du {date(preview.effective_at)}, sans facturation immédiate. Vos
              droits actuels restent en place d’ici là.
            </p>
          )}
          {preview.warnings.length > 0 && (
            <div className="alert alert-info" role="note">
              Au-delà des nouvelles limites (
              {preview.warnings.map((w) => WARNING_LABEL[w.code] ?? w.code).join(', ')}), rien n’est
              supprimé ; seuls les ajouts seront bloqués.
            </div>
          )}
          {preview.capacity.selection_required && (
            <DisplaySelection
              capacity={preview.capacity.display_slots}
              selected={keep}
              onChange={setKeep}
            />
          )}
          <button
            type="button"
            disabled={pending || (preview.capacity.selection_required && keep.length === 0)}
            onClick={() =>
              run(async () => {
                await api(
                  'POST',
                  '/billing/subscription/change',
                  {
                    ...body,
                    ...(preview.proration_date ? { proration_date: preview.proration_date } : {}),
                    ...(preview.capacity.selection_required ? { keep_display_ids: keep } : {}),
                  },
                  idempotencyKey(),
                );
                setPreview(null);
                await props.onDone();
              })
            }
          >
            {preview.kind === 'upgrade' ? 'Confirmer et payer' : 'Programmer le changement'}
          </button>{' '}
          <button type="button" className="link" onClick={() => setPreview(null)}>
            Modifier
          </button>
        </div>
      )}
      <ErrorMessage error={error} />
    </div>
  );
}

function CancelForm(props: {
  view: SubscriptionView;
  fallback: CatalogPlan | undefined;
  onDone(): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [keep, setKeep] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const capacity = props.fallback?.included_display_slots ?? 1;
  const selectionRequired = props.view.display_slots.active > capacity;
  if (!open) {
    return (
      <button type="button" className="link" onClick={() => setOpen(true)}>
        Annuler l’abonnement
      </button>
    );
  }
  return (
    <div className="card">
      <p>
        Le renouvellement s’arrête. Votre abonnement reste actif jusqu’au{' '}
        {date(props.view.subscription?.current_period_end ?? null)}, puis l’organisation passe à
        l’offre {props.fallback?.name ?? 'gratuite'} : {capacity} écran(s),{' '}
        {props.fallback?.entitlements.max_users ?? 1} utilisateur(s). Aucune donnée n’est supprimée.
      </p>
      {selectionRequired && (
        <DisplaySelection capacity={capacity} selected={keep} onChange={setKeep} />
      )}
      <ErrorMessage error={error} />
      <button
        type="button"
        disabled={pending || (selectionRequired && keep.length === 0)}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            await api(
              'POST',
              '/billing/subscription/cancel',
              selectionRequired ? { keep_display_ids: keep } : {},
              idempotencyKey(),
            );
            setOpen(false);
            await props.onDone();
          } catch (caught) {
            setError(caught);
          } finally {
            setPending(false);
          }
        }}
      >
        Confirmer l’annulation
      </button>{' '}
      <button type="button" className="link" onClick={() => setOpen(false)}>
        Garder l’abonnement
      </button>
    </div>
  );
}

function OpenChange(props: { change: Change; canManage: boolean; onDone(): Promise<void> }) {
  const { change } = props;
  const [error, setError] = useState<unknown>(null);
  const label =
    change.kind === 'cancel'
      ? `Annulation programmée au ${date(change.effective_at)}`
      : change.kind === 'downgrade'
        ? `Changement d’offre programmé au ${date(change.effective_at)}`
        : change.kind === 'upgrade'
          ? 'Changement d’offre en attente de paiement'
          : 'Souscription en attente de paiement';
  return (
    <li>
      {label}
      {change.keep_display_ids && ` · ${change.keep_display_ids.length} écran(s) conservé(s)`}
      {change.checkout_url && (
        <>
          {' '}
          · <a href={change.checkout_url}>Reprendre le paiement</a>
        </>
      )}
      {props.canManage && change.status === 'scheduled' && (
        <>
          {' '}
          <button
            type="button"
            className="link"
            onClick={async () => {
              try {
                await api('DELETE', `/billing/changes/${change.id}`);
                await props.onDone();
              } catch (caught) {
                setError(caught);
              }
            }}
          >
            Renoncer
          </button>
        </>
      )}
      <ErrorMessage error={error} />
    </li>
  );
}

/** Retour de Checkout : le serveur relit Stripe ; seul son verdict est affiché (BILL-008). */
function CheckoutReturn({ changeId, onSettled }: { changeId: string; onSettled(): Promise<void> }) {
  const [status, setStatus] = useState<string>('pending_payment');
  useEffect(() => {
    let stop = false;
    let attempts = 0;
    async function poll() {
      while (!stop && attempts < 10) {
        attempts += 1;
        try {
          const change = await api<Change>('GET', `/billing/changes/${changeId}`);
          setStatus(change.status);
          if (change.status !== 'pending_payment' && change.status !== 'requested') {
            await onSettled();
            return;
          }
        } catch {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    void poll();
    return () => {
      stop = true;
    };
  }, [changeId, onSettled]);
  const message =
    status === 'applied'
      ? 'Paiement confirmé : votre abonnement est actif.'
      : status === 'expired' || status === 'failed'
        ? 'Le paiement n’a pas abouti. Aucun montant n’a été prélevé pour cette demande.'
        : 'Paiement en cours de confirmation par le prestataire…';
  return (
    <div className="alert alert-info" role="status" aria-live="polite">
      {message}
    </div>
  );
}

export function BillingPage() {
  const { can } = useSession();
  const [params] = useSearchParams();
  const view = useLoad<SubscriptionView>(can('billing.read') ? '/billing/subscription' : null);
  const catalog = useLoad<{ plans: CatalogPlan[]; indicative: boolean }>('/billing/catalog');
  const [portalError, setPortalError] = useState<unknown>(null);
  const fallback = useMemo(() => catalog.data?.plans.find((plan) => plan.fallback), [catalog.data]);
  if (!can('billing.read'))
    return <Forbidden reason="Votre rôle ne permet pas de consulter l’abonnement." />;
  const data = view.data;
  const canManage = can('billing.manage');
  const returning = params.get('change');
  const paid = data?.subscription && ['active', 'grace', 'pending'].includes(data.state);
  const changeOpen = data?.open_changes.some((change) => change.kind !== 'subscribe');
  return (
    <section>
      <div className="page-header">
        <h1>Abonnement</h1>
      </div>
      {returning && !params.get('cancelled') && (
        <CheckoutReturn changeId={returning} onSettled={view.reload} />
      )}
      <ErrorMessage error={view.error ?? catalog.error} />
      {!data && !view.error && <Loading />}
      {data && (
        <>
          <div className="card">
            <h2>{data.subscribed_plan?.name ?? data.plan.name}</h2>
            <p>{STATE_LABEL[data.state]}</p>
            {data.subscription && data.state !== 'free' && (
              <p className="muted">
                {data.subscription.cancel_at_period_end
                  ? `Se termine le ${date(data.subscription.current_period_end)}`
                  : `Prochaine échéance : ${date(data.subscription.current_period_end)}`}
                {data.subscription.grace_until &&
                  ` · Fin de la période de grâce : ${date(data.subscription.grace_until)}`}
              </p>
            )}
            <ul>
              <li>
                Écrans actifs : {data.display_slots.active} / {data.display_slots.total} (
                {data.display_slots.included} inclus + {data.display_slots.extra} supplémentaire(s))
              </li>
              <li>
                Utilisateurs : {data.users.used} / {data.users.allowed}
              </li>
              <li>
                Stockage : {bytes(data.storage.used_bytes)} / {bytes(data.storage.allowed_bytes)}
              </li>
            </ul>
            {data.display_slots.over_capacity && (
              <div className="alert alert-info" role="note">
                Plus d’écrans actifs que de licences : rien n’est supprimé ni éteint, mais aucun
                nouvel écran ne peut être activé. Désactivez des écrans ou augmentez votre offre.
              </div>
            )}
            {data.sync?.status === 'error' && (
              <p className="muted">
                Synchronisation avec le prestataire de paiement en retard ; l’état affiché est le
                dernier connu.
              </p>
            )}
          </div>
          {data.open_changes.length > 0 && (
            <div className="card">
              <h2>En cours</h2>
              <ul>
                {data.open_changes.map((change) => (
                  <OpenChange
                    key={change.id}
                    change={change}
                    canManage={canManage}
                    onDone={view.reload}
                  />
                ))}
              </ul>
            </div>
          )}
          {canManage && data.purchase_available && catalog.data && (
            <div className="card">
              {!paid && (
                <>
                  <h2>Souscrire</h2>
                  <SubscribeForm catalog={catalog.data.plans} />
                </>
              )}
              {paid && !changeOpen && !data.subscription?.cancel_at_period_end && (
                <>
                  <h2>Modifier l’abonnement</h2>
                  <ChangeForm catalog={catalog.data.plans} view={data} onDone={view.reload} />
                  <div>
                    <CancelForm view={data} fallback={fallback} onDone={view.reload} />
                  </div>
                </>
              )}
              {data.subscription && (
                <p>
                  <button
                    type="button"
                    className="link"
                    onClick={async () => {
                      try {
                        const session = await api<{ url: string }>(
                          'POST',
                          '/billing/portal-session',
                        );
                        window.location.assign(session.url);
                      } catch (caught) {
                        setPortalError(caught);
                      }
                    }}
                  >
                    Factures et moyen de paiement
                  </button>
                </p>
              )}
              <ErrorMessage error={portalError} />
            </div>
          )}
          {catalog.data?.indicative && (
            <p className="muted">Les tarifs affichés sont indicatifs et susceptibles d’évoluer.</p>
          )}
        </>
      )}
    </section>
  );
}
