import Type, { type Static } from 'typebox';
import { Strict, Timezone, Uuid } from './common.js';

/**
 * En-tête désignant l’organisation active d’une requête utilisateur (API-002).
 * Le serveur le confronte aux memberships ; un Player n’envoie jamais de tenant
 * faisant autorité : il provient de son identité authentifiée.
 */
export const ORGANIZATION_HEADER = 'x-organization-id';

export const OrganizationStatus = Type.Union([
  Type.Literal('active'),
  Type.Literal('suspended'),
  Type.Literal('deletion_pending'),
  Type.Literal('deleted'),
]);

export const Organization = Type.Object(
  {
    id: Uuid,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    slug: Type.String({ pattern: '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' }),
    country: Type.String({ pattern: '^[A-Z]{2}$' }),
    timezone: Timezone,
    status: OrganizationStatus,
  },
  { ...Strict, title: 'Organization' },
);
export type Organization = Static<typeof Organization>;
