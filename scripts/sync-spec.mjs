import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
export async function expectedFiles() {
  const source = (await readFile(resolve(root, 'docs/spec/cahier-des-charges.md'), 'utf8')).replace(/\r\n/g, '\n');
  const starts = [...source.matchAll(/^<a id="section-(\d+)"><\/a>\n+## \d+\. ([^\n]+)/gm)];
  if (starts.length !== 24) throw new Error('La spécification doit contenir 24 chapitres ancrés.');
  const files = new Map();
  const requirements = {};
  const rows = [];
  for (let i = 0; i < starts.length; i++) {
    const n = Number(starts[i][1]);
    if (n !== i + 1) throw new Error('Numérotation des chapitres invalide.');
    const name = String(n).padStart(2, '0');
    const body = source.slice(starts[i].index, starts[i + 1]?.index ?? source.length).trim();
    files.set(`docs/spec/chapters/${name}.md`, `<!-- Généré par scripts/sync-spec.mjs ; modifier le cahier maître. -->\n\n[Retour à l’index](../INDEX.md) · [Source maître](../cahier-des-charges.md#section-${n})\n\n${body}\n`);
    rows.push(`| ${n} | [${starts[i][2]}](chapters/${name}.md) |`);
    for (const [, id] of body.matchAll(/\b([A-Z][A-Z0-9]*-\d{3})\b/g)) {
      const chapters = requirements[id] ??= [];
      if (!chapters.includes(n)) chapters.push(n);
    }
  }
  files.set('docs/spec/INDEX.md', `# Index du cahier des charges pixlova\n\n<!-- Généré par scripts/sync-spec.mjs. -->\n\nLe [cahier maître](cahier-des-charges.md) est la source de référence. Les chapitres ci-dessous en sont des copies générées pour limiter le contexte nécessaire aux agents. Les propositions conservent leur statut d’origine.\n\n| Chapitre | Sujet |\n| --- | --- |\n${rows.join('\n')}\n\n[requirements.json](requirements.json) indexe les **occurrences** d’identifiants par chapitre ; une occurrence peut être une référence et ne constitue pas une nouvelle exigence.\n\nAprès modification du maître : node scripts/sync-spec.mjs.\n`);
  files.set('docs/spec/requirements.json', JSON.stringify({ description: 'Occurrences des identifiants par chapitre, définitions et références comprises.', requirements: Object.fromEntries(Object.entries(requirements).sort(([a], [b]) => a.localeCompare(b))) }, null, 2) + '\n');
  return files;
}

export async function sync(check = false) {
  const files = await expectedFiles();
  for (const [name, expected] of files) {
    const path = resolve(root, name);
    if (check) {
      const actual = await readFile(path, 'utf8').catch(() => '');
      if (actual.replace(/\r\n/g, '\n') !== expected) throw new Error(`Fichier généré absent ou périmé : ${name}`);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, expected);
    }
  }
  return files.size;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`${await sync(process.argv.includes('--check'))} fichiers générés ${process.argv.includes('--check') ? 'vérifiés' : 'actualisés'}.`);
}
