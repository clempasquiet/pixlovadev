import type { ManifestContent } from '@pixlova/contracts';
import { mountStage, renderContent, type Rendered } from '@pixlova/render-engine/dom';
import '@pixlova/render-engine/fonts.css';
import { generateAssets } from './assets.js';
import { measureAll, type MeasureReport } from './measure.js';
import { environment, firstFrame, probeCodecs, sampleFrames } from './metrics.js';
import { scenarios, type Scenario } from './scenarios.js';

interface ScenarioResult {
  id: string;
  title: string;
  status: 'ok' | 'skipped' | 'error';
  display: Scenario['display'];
  first_frame_ms: number | null;
  frames: Awaited<ReturnType<typeof sampleFrames>> | null;
  errors: string[];
}

interface LabState {
  status: 'idle' | 'running' | 'done';
  /** Mode `measure` : relevé géométrique des compositions de référence (ADR-010). */
  measure?: MeasureReport;
  results: {
    lab_version: string;
    measured_at: string;
    environment: ReturnType<typeof environment>;
    codecs: Awaited<ReturnType<typeof probeCodecs>>;
    scenarios: ScenarioResult[];
  } | null;
}

declare global {
  interface Window {
    __PIXLOVA_LAB__: LabState;
    /** Canal IPC injecté par le renderer natif (wry) ; absent dans un navigateur. */
    ipc?: { postMessage(message: string): void };
  }
}

const surface = document.querySelector<HTMLElement>('#surface')!;
const panel = document.querySelector<HTMLElement>('#panel')!;
const output = document.querySelector<HTMLElement>('#output')!;
const params = new URLSearchParams(location.search);
window.__PIXLOVA_LAB__ = { status: 'idle', results: null };

async function runScenario(
  scenario: Scenario,
  assets: Map<string, string>,
  durationMs: number,
): Promise<ScenarioResult> {
  const result: ScenarioResult = {
    id: scenario.id,
    title: scenario.title,
    status: 'ok',
    display: scenario.display,
    first_frame_ms: null,
    frames: null,
    errors: [],
  };
  if (scenario.needsVideo && !assets.has('00000000-0000-4000-8000-00000000b001')) {
    return { ...result, status: 'skipped', errors: ['Aucune vidéo fournie'] };
  }
  const contents = new Map<string, ManifestContent>(scenario.contents.map((c) => [c.id, c]));
  const stage = mountStage(
    surface,
    scenario.display.width,
    scenario.display.height,
    scenario.display.orientation,
    'contain',
  );
  stage.dataset.scenario = scenario.id;
  let rendered: Rendered | undefined;
  try {
    rendered = renderContent(
      contents.get(scenario.root)!,
      scenario.display.width,
      scenario.display.height,
      {
        resolveAsset: (id) => assets.get(id) ?? '',
        contents,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        now: () => Date.now(),
        onError: (error) =>
          result.errors.push(`${error.reason} ${error.contentRef ?? ''} ${error.detail}`),
      },
    );
    stage.append(rendered.element);
    result.first_frame_ms = await firstFrame(stage);
    result.frames = await sampleFrames(stage, durationMs);
  } catch (error) {
    result.status = 'error';
    result.errors.push(String(error));
  }
  if (result.errors.length > 0 && result.status === 'ok') result.status = 'error';
  if (!params.has('keep')) {
    rendered?.destroy();
    surface.replaceChildren();
  }
  return result;
}

async function run(only: string | null): Promise<void> {
  window.__PIXLOVA_LAB__.status = 'running';
  const file = document.querySelector<HTMLInputElement>('#video')!.files?.[0] ?? null;
  const assets = await generateAssets(file);
  const videoUrl = params.get('video');
  if (videoUrl) assets.set('00000000-0000-4000-8000-00000000b001', videoUrl);
  const durationMs =
    1000 *
    Number(params.get('duration') ?? document.querySelector<HTMLInputElement>('#duration')!.value);
  panel.hidden = true;
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios(assets.has('00000000-0000-4000-8000-00000000b001'))) {
    if (only && scenario.id !== only) continue;
    results.push(await runScenario(scenario, assets, durationMs));
  }
  window.__PIXLOVA_LAB__ = {
    status: 'done',
    results: {
      lab_version: '0.1.1',
      measured_at: new Date().toISOString(),
      environment: environment(),
      codecs: await probeCodecs(),
      scenarios: results,
    },
  };
  if (!params.has('keep')) panel.hidden = false;
  output.textContent = JSON.stringify(window.__PIXLOVA_LAB__.results, null, 2);
  window.ipc?.postMessage(output.textContent);
  document.querySelector<HTMLButtonElement>('#download')!.disabled = false;
}

document.querySelector('#run')!.addEventListener('click', () => void run(null));
document
  .querySelector('#fullscreen')!
  .addEventListener('click', () => void document.documentElement.requestFullscreen?.());
document.querySelector('#download')!.addEventListener('click', () => {
  const blob = new Blob([output.textContent ?? ''], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `pixlova-render-lab-${Date.now()}.json`;
  link.click();
});

async function measure(only: string | null): Promise<void> {
  window.__PIXLOVA_LAB__.status = 'running';
  panel.hidden = true;
  const assets = await generateAssets(null);
  const report = await measureAll(surface, assets, only);
  window.__PIXLOVA_LAB__ = { status: 'done', results: null, measure: report };
  output.textContent = JSON.stringify(report, null, 2);
  window.ipc?.postMessage(output.textContent);
}

if (params.has('measure')) void measure(params.get('fixture'));
else if (params.has('auto')) void run(params.get('scenario'));
