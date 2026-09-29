import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { root, sync } from './sync-spec.mjs';

const ignored = new Set(['.git', 'node_modules', 'target', 'dist', 'build', 'coverage', 'work']);
async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}
function prose(text, name) {
  const result = [];
  let fence = null;
  let block = [];
  let language = '';
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (match && !fence) {
      fence = match[1]; language = match[2].trim(); block = [];
    } else if (match && match[1][0] === fence?.[0] && match[1].length >= fence.length && !match[2].trim()) {
      if (language === 'json') {
        try { JSON.parse(block.join('\n')); } catch (e) { throw new Error(`${name} : JSON invalide : ${e.message}`); }
      }
      fence = null;
    } else if (fence) block.push(line);
    else result.push(line);
  }
  if (fence) throw new Error(`${name} : bloc de code non fermé.`);
  return result.join('\n');
}
function anchors(text) {
  const ids = new Set([...text.matchAll(/<a\s+id="([^"]+)"/g)].map(m => m[1]));
  const duplicates = new Map();
  for (const [, heading] of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = heading.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/ /g, '-');
    const count = duplicates.get(base) ?? 0;
    ids.add(count ? `${base}-${count}` : base);
    duplicates.set(base, count + 1);
  }
  return ids;
}

await sync(true);
const files = await walk(root);
const markdown = files.filter(p => p.endsWith('.md'));
let links = 0;
for (const path of markdown) {
  const text = prose(await readFile(path, 'utf8'), relative(root, path));
  for (const [, raw] of text.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const href = raw.replace(/^<|>$/g, '');
    if (/^[a-z][a-z\d+.-]*:/i.test(href)) continue;
    const [local, fragment] = href.split('#');
    const target = local ? resolve(dirname(path), decodeURIComponent(local)) : path;
    if (!(await stat(target).catch(() => null))) throw new Error(`${relative(root, path)} : lien introuvable ${href}`);
    if (fragment && target.endsWith('.md')) {
      const targetText = prose(await readFile(target, 'utf8'), target);
      if (!anchors(targetText).has(decodeURIComponent(fragment))) throw new Error(`${relative(root, path)} : ancre introuvable ${href}`);
    }
    links++;
  }
}
const tasks = JSON.parse(await readFile(resolve(root, 'docs/planning/tasks.json'), 'utf8'));
const reqs = JSON.parse(await readFile(resolve(root, 'docs/spec/requirements.json'), 'utf8')).requirements;
const ids = new Set(tasks.map(t => t.id));
if (ids.size !== tasks.length) throw new Error('Identifiants de lots dupliqués.');
const visited = new Set();
const active = new Set();
function visit(id) {
  if (active.has(id)) throw new Error(`Cycle de dépendances : ${id}`);
  if (visited.has(id)) return;
  const task = tasks.find(t => t.id === id);
  if (!task) throw new Error(`Dépendance inconnue : ${id}`);
  active.add(id);
  for (const dependency of task.depends) visit(dependency);
  for (const requirement of task.requirements) if (!reqs[requirement]) throw new Error(`${id} : exigence inconnue ${requirement}`);
  for (const chapter of task.chapters) if (!Number.isInteger(chapter) || chapter < 1 || chapter > 24) throw new Error(`${id} : chapitre invalide`);
  if (!task.acceptance.length) throw new Error(`${id} : recette manquante`);
  active.delete(id); visited.add(id);
}
for (const task of tasks) visit(task.id);
for (const path of files.filter(p => p.endsWith('.json'))) JSON.parse(await readFile(path, 'utf8'));
console.log(`OK : ${markdown.length} documents Markdown, ${links} liens locaux, ${tasks.length} lots sans cycle, chapitres synchronisés et JSON valides.`);
console.log('Ces contrôles ne valident pas une application, un Player ou un déploiement.');
