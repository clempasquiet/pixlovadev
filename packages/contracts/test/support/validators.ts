/**
 * Validateurs précompilés (Ajv standalone) des documents reçus par un Player : le Player
 * Web s’exécute sous une CSP sans `unsafe-eval`, qui interdit la compilation à la volée
 * (ADR-013). Mêmes options que `validator()` ; le code produit est déterministe.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import standalone from 'ajv/dist/standalone/index.js';
import { ROOT_SCHEMAS, type RootSchemaName } from '../../src/index.js';

export const PLAYER_VALIDATED: RootSchemaName[] = ['manifest-payload.json', 'command-payload.json'];

const UCS2LENGTH = `function ucs2length(str) {
  const len = str.length;
  let length = 0;
  let pos = 0;
  let value;
  while (pos < len) {
    length++;
    value = str.charCodeAt(pos++);
    if (value >= 0xd800 && value <= 0xdbff && pos < len) {
      value = str.charCodeAt(pos);
      if ((value & 0xfc00) === 0xdc00) pos++;
    }
  }
  return length;
}`;

const identifier = (name: string) => `v_${name.replace(/\.json$/, '').replace(/-/g, '_')}`;

export function buildPlayerValidators(): string {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: false,
    allowUnionTypes: true,
    code: { source: true, esm: true },
  });
  const refs: Record<string, string> = {};
  for (const name of PLAYER_VALIDATED) {
    const schema = ROOT_SCHEMAS[name] as unknown as { $id: string };
    ajv.addSchema(schema);
    refs[identifier(name)] = schema.$id;
  }
  // Module CommonJS : la fonction est l’export par défaut ou le module lui-même.
  type Generate = (instance: Ajv2020, refs: Record<string, string>) => string;
  const module = standalone as unknown as Generate & { default?: Generate };
  const generate = module.default ?? module;
  const code = generate(ajv, refs).replace(
    /require\("ajv\/dist\/runtime\/ucs2length"\)\.default/g,
    'ucs2length',
  );
  if (code.includes('require(')) throw new Error('dépendance d’exécution Ajv non prise en charge');
  const map = PLAYER_VALIDATED.map((name) => `  '${name}': ${identifier(name)},`).join('\n');
  return `// @ts-nocheck
/* Généré par « pnpm --filter @pixlova/contracts generate » : ne pas modifier. */
${UCS2LENGTH}
${code}
export const PRECOMPILED = {
${map}
};
`;
}
