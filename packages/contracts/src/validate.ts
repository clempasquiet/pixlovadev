import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { PRECOMPILED } from './generated/player-validators.js';
import { ROOT_SCHEMAS, type RootSchemaName } from './schemas/index.js';

/**
 * Validateurs JSON Schema. Les documents reçus par un Player (manifest, commande) ont des
 * validateurs précompilés : aucun code n’est généré à l’exécution, ce qui permet au
 * Player Web une CSP sans `unsafe-eval` (ADR-013). Les autres sont compilés à la demande.
 */
const precompiled = PRECOMPILED as Partial<Record<RootSchemaName, ValidateFunction>>;

let ajv: Ajv2020 | undefined;
const cache = new Map<RootSchemaName, ValidateFunction>();

export function validator(name: RootSchemaName): ValidateFunction {
  const ready = precompiled[name];
  if (ready) return ready;
  let validate = cache.get(name);
  if (!validate) {
    ajv ??= new Ajv2020({ strict: true, allErrors: false, allowUnionTypes: true });
    validate = ajv.compile(ROOT_SCHEMAS[name]);
    cache.set(name, validate);
  }
  return validate;
}

export function describeErrors(errors: ErrorObject[] | null | undefined): string {
  const first = errors?.[0];
  if (!first) return 'document invalide';
  return `${first.instancePath || '/'} ${first.message ?? 'invalide'}`;
}
