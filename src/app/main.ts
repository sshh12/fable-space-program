/**
 * Application entry point. Boot order:
 *   1. install window.__test (error capture starts before anything can fail) and put up the loading screen
 *   2. acquire the high-performance WebGPU adapter and device
 *   3. load the data-driven definitions and pick the scenario (?scenario=, default: the definitions' mission)
 *   4. build the game (game.ts): height authority and simulation, renderer with every feature, input, HUD,
 *      map view, cameras, audio; wait for the pad terrain, the features' start-up and the sound assets
 *   5. run the frame loop under the loading screen until the view at the start position is final, then fade;
 *      window.__test.ready resolves three presented frames after the screen has gone
 * Every subsystem is attached through its contract (src/core/contracts); see docs/handoff/app-integration-v1.md.
 */
import type { DefSource } from '@/core/defs/loader';
import { fetchDefSource } from '@/core/defs/fetchSource';
import { loadDefs } from '@/core/defs/loader';
import { acquireGpu } from '@/core/gpu/device';
import { installTestApi } from '@/core/testing/testApi';
import { createGame } from './game';
import { createLoadingScreen, type LoadingReport } from './loading';
import { readSettings, resolveScenario } from './settings';
import { installGameTestHooks } from './testHooks';

declare global {
  interface Window {
    /** The loading screen's state, from the first moment of the page (the specs read it before `__app` exists). */
    __boot?: () => LoadingReport;
  }
}

const query = new URLSearchParams(location.search);
const settings = readSettings(query);
const testApi = installTestApi({ kind: 'app', name: 'main', scenarioId: settings.scenarioId });
const loading = createLoadingScreen(document.body);
window.__boot = () => loading.report();

function showFatal(message: string): void {
  loading.abort();
  const box = document.getElementById('fatal');
  const text = document.getElementById('fatal-message');
  if (text) text.textContent = message;
  box?.classList.add('visible');
}

/** The definitions' source with a count of the files read against the files listed (the loading screen's numbers). */
function countedDefSource(source: DefSource, onProgress: (read: number, listed: number) => void): DefSource {
  const seen = new Set<string>();
  let listed = 0;
  return {
    async list() {
      const files = await source.list();
      listed = files.length;
      onProgress(seen.size, listed);
      return files;
    },
    async read(path) {
      const value = await source.read(path);
      if (value !== undefined) seen.add(path);
      onProgress(seen.size, listed);
      return value;
    },
  };
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui-root') as HTMLElement;
  loading.begin('gpu', { detail: 'WebGPU adapter and device' });
  const gpu = await acquireGpu({ onError: testApi.reportError });
  testApi.setAdapter(gpu.report);
  loading.finish('gpu', { detail: gpu.report.description || `${gpu.report.vendor} ${gpu.report.architecture}`.trim() });

  loading.begin('defs', { detail: 'bodies, sites, parts, vehicles, scenarios' });
  const defs = await loadDefs(countedDefSource(fetchDefSource('/defs'), (read, listed) => loading.update('defs', { detail: 'files read', done: read, total: listed })));
  document.documentElement.dataset['bodies'] = Object.keys(defs.bodies).sort().join(',');
  const scenarioId = resolveScenario(defs, settings.scenarioId);
  document.documentElement.dataset['scenario'] = scenarioId;
  const scenario = defs.scenarios[scenarioId]!;
  loading.finish('defs', { detail: `${Object.keys(defs.bodies).length} bodies, ${Object.keys(defs.parts).length} parts, ${Object.keys(defs.vehicles).length} vehicles, ${Object.keys(defs.scenarios).length} scenarios` });
  loading.setHeading(scenario.name, scenario.start.kind === 'pad' ? (defs.sites[scenario.site]?.name ?? '') : (defs.vehicles[scenario.vehicle]?.name ?? ''));

  const game = await createGame({
    canvas,
    uiRoot,
    gpu,
    defs,
    scenarioId,
    settings,
    loading,
    reportError: testApi.reportError,
    onFrameDone: () => testApi.frameDone(),
    onFatal: showFatal,
  });
  installGameTestHooks(testApi, game);
  canvas.focus();
  await game.revealed;
  await testApi.api.waitFrames(3);
}

boot().then(
  () => testApi.markReady(testApi.api.errors.length === 0),
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    testApi.reportError(message);
    showFatal(message);
    testApi.markReady(false);
  },
);
