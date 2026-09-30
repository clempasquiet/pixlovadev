import Type from 'typebox';

/** Schémas d’entrée : propriétés inconnues refusées (API-003). */
export const Strict = { additionalProperties: false } as const;
export const Email = Type.String({
  minLength: 3,
  maxLength: 254,
  pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
});
export const Password = Type.String({ minLength: 1, maxLength: 1024 });
export const Token = Type.String({ minLength: 20, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' });
export const Uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});
export const TotpCode = Type.String({ pattern: '^[0-9]{6}$' });
export const RecoveryCode = Type.String({ pattern: '^[a-z0-9]{5}-[a-z0-9]{5}$' });
export const RoleKey = Type.Union(
  ['Owner', 'Admin', 'ContentManager', 'Operator', 'Technician', 'Viewer', 'BillingManager'].map(
    (r) => Type.Literal(r),
  ),
);
export const GrantInput = Type.Object(
  {
    role: RoleKey,
    scope: Type.Union([
      Type.Object({ type: Type.Literal('organization') }, Strict),
      Type.Object(
        {
          type: Type.Literal('sites'),
          site_ids: Type.Array(Uuid, { minItems: 1, maxItems: 100, uniqueItems: true }),
        },
        Strict,
      ),
    ]),
  },
  Strict,
);
export type GrantInput = Type.Static<typeof GrantInput>;
