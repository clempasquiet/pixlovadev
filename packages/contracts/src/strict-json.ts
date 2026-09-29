/**
 * Analyseur JSON strict pour les documents signés (PROTO-011) :
 * - clés dupliquées refusées (`JSON.parse` garderait silencieusement la dernière) ;
 * - nombres de valeur absolue supérieure à 2^53−1 refusés (représentation non
 *   identique entre TypeScript et Rust) ;
 * - chaînes contenant une moitié de paire de substitution refusées ;
 * - profondeur bornée.
 * Les mêmes règles sont appliquées par la crate Rust `pixlova-contracts`.
 */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class StrictJsonError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(`${message} (position ${position})`);
    this.name = 'StrictJsonError';
  }
}

export const MAX_JSON_DEPTH = 64;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
// Les caractères de contrôle bruts sont interdits dans une chaîne JSON (RFC 8259 §7).
// eslint-disable-next-line no-control-regex
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const WHITESPACE = /[ \t\n\r]*/y;

export function parseStrictJson(text: string): JsonValue {
  let pos = 0;

  const fail = (message: string): never => {
    throw new StrictJsonError(message, pos);
  };
  const skip = () => {
    WHITESPACE.lastIndex = pos;
    WHITESPACE.exec(text);
    pos = WHITESPACE.lastIndex;
  };
  const readString = (): string => {
    STRING.lastIndex = pos;
    const match = STRING.exec(text);
    if (!match) fail('chaîne invalide');
    pos = STRING.lastIndex;
    const value = JSON.parse(match![0]) as string;
    if (!value.isWellFormed()) fail('substitut Unicode isolé');
    return value;
  };
  const readValue = (depth: number): JsonValue => {
    skip();
    const char = text[pos];
    // `depth` = conteneurs déjà ouverts ; au plus MAX_JSON_DEPTH conteneurs imbriqués.
    if ((char === '{' || char === '[') && depth >= MAX_JSON_DEPTH) {
      fail('profondeur maximale dépassée');
    }
    if (char === '{') {
      pos++;
      const object: { [key: string]: JsonValue } = {};
      const keys = new Set<string>();
      skip();
      if (text[pos] === '}') {
        pos++;
        return object;
      }
      for (;;) {
        skip();
        if (text[pos] !== '"') fail('clé attendue');
        const key = readString();
        if (keys.has(key)) fail(`clé dupliquée « ${key} »`);
        keys.add(key);
        skip();
        if (text[pos] !== ':') fail('« : » attendu');
        pos++;
        // defineProperty : une clé « __proto__ » reste une propriété ordinaire.
        Object.defineProperty(object, key, {
          value: readValue(depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        skip();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === '}') {
          pos++;
          return object;
        }
        fail('« , » ou « } » attendu');
      }
    }
    if (char === '[') {
      pos++;
      const array: JsonValue[] = [];
      skip();
      if (text[pos] === ']') {
        pos++;
        return array;
      }
      for (;;) {
        array.push(readValue(depth + 1));
        skip();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === ']') {
          pos++;
          return array;
        }
        fail('« , » ou « ] » attendu');
      }
    }
    if (char === '"') return readString();
    if (text.startsWith('true', pos)) {
      pos += 4;
      return true;
    }
    if (text.startsWith('false', pos)) {
      pos += 5;
      return false;
    }
    if (text.startsWith('null', pos)) {
      pos += 4;
      return null;
    }
    NUMBER.lastIndex = pos;
    const match = NUMBER.exec(text);
    if (!match) return fail('valeur attendue');
    pos = NUMBER.lastIndex;
    const value = Number(match[0]);
    if (!Number.isFinite(value) || Math.abs(value) > MAX_SAFE) fail('nombre hors plage');
    return value;
  };

  const value = readValue(0);
  skip();
  if (pos !== text.length) fail('contenu après la valeur JSON');
  return value;
}
