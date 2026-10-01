import { environmentOfKey, StripeGateway, type BillingGateway } from '@pixlova/billing';
import type { BillingEnvironment } from '@pixlova/contracts';
import type { Deployment } from './entitlements.js';

/** Facturation (ADR-017). Valeurs commerciales à valider : surchargeables par l’environnement. */
export interface BillingConfig {
  /** Passerelle Stripe ; absente, le catalogue et les droits restent servis, les achats répondent 503. */
  gateway: BillingGateway | null;
  /** Environnement Stripe dont les prix et abonnements sont lus. */
  environment: BillingEnvironment;
  /** Grâce d’un impayé avant restriction (BILL-015, 7 jours proposés, à valider). */
  graceDays: number;
  /** Validité d’une session Checkout (Stripe : 30 min à 24 h). */
  checkoutMinutes: number;
}

function readNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} doit être un entier entre ${min} et ${max}.`);
  }
  return value;
}

/**
 * Environnement Stripe lu par l’API et l’administration : celui de la clé quand elle est
 * fournie, sinon `PIXLOVA_BILLING_ENVIRONMENT` (le conteneur d’administration ne détient
 * pas la clé Stripe). `test` par défaut.
 */
export function billingEnvironmentFromEnv(env: NodeJS.ProcessEnv): BillingEnvironment {
  const declared = env.PIXLOVA_BILLING_ENVIRONMENT;
  if (declared !== undefined && declared !== 'test' && declared !== 'live') {
    throw new Error('PIXLOVA_BILLING_ENVIRONMENT doit valoir test ou live.');
  }
  const fromKey = env.STRIPE_SECRET_KEY ? environmentOfKey(env.STRIPE_SECRET_KEY) : null;
  if (fromKey && declared && fromKey !== declared) {
    throw new Error('PIXLOVA_BILLING_ENVIRONMENT ne correspond pas au mode de STRIPE_SECRET_KEY.');
  }
  return fromKey ?? declared ?? 'test';
}

/**
 * Configuration Stripe : `STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET` vont ensemble. Une
 * clé de production (`sk_live_`) n’est acceptée qu’en déploiement `production` : aucun vrai
 * débit possible en recette ou en développement (ticket L08).
 */
export function billingFromEnv(
  env: NodeJS.ProcessEnv,
  deployment: Deployment,
  createGateway: (config: { secretKey: string; webhookSecret: string }) => BillingGateway = (
    config,
  ) => new StripeGateway(config),
): BillingConfig {
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (Boolean(secretKey) !== Boolean(webhookSecret)) {
    throw new Error('STRIPE_SECRET_KEY et STRIPE_WEBHOOK_SECRET vont ensemble.');
  }
  const environment = billingEnvironmentFromEnv(env);
  if (environment === 'live' && deployment !== 'production') {
    throw new Error(
      'La facturation Stripe de production est interdite hors déploiement production.',
    );
  }
  const gateway = secretKey && webhookSecret ? createGateway({ secretKey, webhookSecret }) : null;
  return {
    gateway,
    environment,
    graceDays: readNumber(env, 'PIXLOVA_BILLING_GRACE_DAYS', 7, 0, 60),
    checkoutMinutes: readNumber(env, 'PIXLOVA_BILLING_CHECKOUT_MINUTES', 60, 30, 24 * 60),
  };
}
