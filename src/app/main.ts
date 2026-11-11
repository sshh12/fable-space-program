/**
 * Application entry point. Boot order:
 *   1. install window.__test (error capture starts before anything can fail)
 *   2. acquire the high-performance WebGPU adapter and device
 *   3. load the data-driven definitions and pick the scenario (?scenario=, default: the definitions' mission)
 *   4. build the game (game.ts): height authority and simulation, renderer with every feature, input, HUD,
 *      map view, cameras, audio; wait for the pad terrain, the features' start-up and the sound assets
 *   5. run the frame loop; window.__test.ready resolves after the first frames are presented
 * Every subsystem is attached through its contract (src/core/contracts); see docs/handoff/app-integration-v1.md.
 */
import { fetchDefSource } from '@/core/defs/fetchSource';
import { loadDefs } from '@/core/defs/loader';
import { acquireGpu } from '@/core/gpu/device';
import { installTestApi } from '@/core/testing/testApi';
import { createGame } from './game';
import { readSettings, resolveScenario } from './settings';
import { installGameTestHooks } from './testHooks';

const query = new URLSearchParams(location.search);
const settings = readSettings(query);
const testApi = installTestApi({ kind: 'app', name: 'main', scenarioId: settings.scenarioId });

function showFatal(message: string): void {
  const box = document.getElementById('fatal');
  const text = document.getElementById('fatal-message');
  if (text) text.textContent = message;
  box?.classList.add('visible');
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui-root') as HTMLElement;
  const gpu = await acquireGpu({ onError: testApi.reportError });
  testApi.setAdapter(gpu.report);

  const defs = await loadDefs(fetchDefSource('/defs'));
  document.documentElement.dataset['bodies'] = Object.keys(defs.bodies).sort().join(',');
  const scenarioId = resolveScenario(defs, settings.scenarioId);
  document.documentElement.dataset['scenario'] = scenarioId;

  const game = await createGame({
    canvas,
    uiRoot,
    gpu,
    defs,
    scenarioId,
    settings,
    reportError: testApi.reportError,
    onFrameDone: () => testApi.frameDone(),
    onFatal: showFatal,
  });
  installGameTestHooks(testApi, game);
  canvas.focus();
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
