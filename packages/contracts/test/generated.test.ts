import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildArtifacts } from './support/artifacts.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const update = process.env.PIXLOVA_UPDATE_CONTRACTS === '1';

describe('artefacts générés (schémas JSON et fixtures)', () => {
  const artifacts = buildArtifacts();

  for (const [path, expected] of artifacts) {
    it(`${path} est à jour`, async () => {
      const target = resolve(packageRoot, path);
      if (update) {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, expected);
      }
      const actual = await readFile(target, 'utf8').catch(() => '');
      expect(actual, `Régénérer avec « pnpm --filter @pixlova/contracts generate »`).toBe(expected);
    });
  }
});
