import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { ROOT_SCHEMAS, type RootSchemaName } from './schemas/index.js';

/**
 * Validateurs JSON Schema compilés à la demande.
 * Limite connue : Ajv génère du code (`new Function`) ; le Player Web, soumis à une CSP
 * sans `unsafe-eval`, utilisera des validateurs précompilés (suivi L06-W).
 */
const ajv = new Ajv2020({ strict: true, allErrors: false, allowUnionTypes: true });
const cache = new Map<RootSchemaName, ValidateFunction>();

export function validator(name: RootSchemaName): ValidateFunction {
  let validate = cache.get(name);
  if (!validate) {
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
