#!/usr/bin/env node
/**
 * Compare deux relevés du mode `measure` du banc (ADR-010) — par exemple Chromium
 * (preview, Player Web) et le renderer natif WebKitGTK ou WebView2 — et échoue si :
 * - une police qualifiée n’est pas chargée, une image n’est pas décodée ;
 * - un élément s’écarte de plus de 1 px de la géométrie calculée par le moteur ;
 * - le nombre de lignes d’un texte ou le texte d’une horloge diffère entre moteurs.
 *
 *   node scripts/compare-render.mjs reference.json candidat.json [--markdown sortie.md]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--'));
const [referencePath, candidatePath, ...rest] = args;
if (!referencePath || !candidatePath) {
  console.error('Usage : compare-render.mjs reference.json candidat.json [--markdown sortie.md]');
  process.exit(2);
}
const markdownPath = rest[0] === '--markdown' ? rest[1] : null;
const load = (path) => {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  if (report.kind !== 'pixlova-render-measure') throw new Error(`${path} : relevé inconnu`);
  return report;
};
const reference = load(referencePath);
const candidate = load(candidatePath);
const TOLERANCE = 1;
const problems = [];
const rows = [];

for (const [label, report] of [['référence', reference], ['candidat', candidate]]) {
  for (const fixture of report.fixtures) {
    for (const font of fixture.fonts.filter((f) => !f.loaded)) {
      problems.push(`${label} ${fixture.id} : police ${font.family} ${font.weight} non chargée`);
    }
    if (fixture.images.failed > 0) problems.push(`${label} ${fixture.id} : ${fixture.images.failed} image(s) non décodée(s)`);
    for (const error of fixture.errors) problems.push(`${label} ${fixture.id} : ${error}`);
  }
}

for (const fixture of reference.fixtures) {
  const other = candidate.fixtures.find((f) => f.id === fixture.id);
  if (!other) {
    problems.push(`${fixture.id} : absent du relevé candidat`);
    continue;
  }
  let maxRef = 0;
  let maxCand = 0;
  let lineMismatch = 0;
  for (const element of fixture.elements) {
    const peer = other.elements.find((e) => e.id === element.id);
    if (!peer) {
      problems.push(`${fixture.id}/${element.id} : absent du relevé candidat`);
      continue;
    }
    maxRef = Math.max(maxRef, element.delta);
    maxCand = Math.max(maxCand, peer.delta);
    for (const [label, entry] of [['référence', element], ['candidat', peer]]) {
      if (entry.delta > TOLERANCE) {
        problems.push(`${label} ${fixture.id}/${element.id} : écart ${entry.delta} px (> ${TOLERANCE})`);
      }
    }
    if (element.lines !== undefined && element.lines !== peer.lines) {
      lineMismatch += 1;
      problems.push(`${fixture.id}/${element.id} : ${element.lines} ligne(s) contre ${peer.lines}`);
    }
    if (element.text !== undefined && element.text !== peer.text) {
      problems.push(`${fixture.id}/${element.id} : horloge « ${element.text} » contre « ${peer.text} »`);
    }
  }
  const texts = fixture.elements.filter((e) => e.lines !== undefined).length;
  rows.push(
    `| ${fixture.id} | ${fixture.elements.length} | ${maxRef} px | ${maxCand} px | ${texts - lineMismatch}/${texts} | ${fixture.fonts.length} |`,
  );
}

const lines = [
  `Référence : ${reference.user_agent}`,
  `Candidat : ${candidate.user_agent}`,
  '',
  '| Composition | Éléments | Écart max. référence | Écart max. candidat | Textes au même nombre de lignes | Polices |',
  '|---|---:|---:|---:|---:|---:|',
  ...rows,
  '',
  problems.length === 0 ? 'Résultat : identique (tolérance 1 px).' : `Résultat : ${problems.length} écart(s).`,
  ...problems.map((p) => `- ${p}`),
];
console.log(lines.join('\n'));
if (markdownPath) writeFileSync(markdownPath, `${lines.join('\n')}\n`);
process.exit(problems.length === 0 ? 0 : 1);
