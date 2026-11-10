/**
 * Audio lab: the live AudioEngine driven by a FakeSim scene whose engine parts, aero state, g-load and
 * events come from the controls; live bus meters from probe(); offline acceptance renders and clip
 * recording through window.__audioLab (labApi.ts).
 *
 * Sound starts on the first real key press or click (the engine is created suspended).
 * Query: ?scene=<FakeScene>&stack=<booster|upper|tli|lander|ascent|capsule|vehicle:<id>>&kind=<interior|external|map>
 */
import { createAudioEngine, type FableAudioEngine } from '@/audio';
import type { AudioBusName, AudioFrame, AudioProbe } from '@/core/contracts/audio';
import type { DefLibrary } from '@/core/contracts/defs';
import type { ViewKind } from '@/core/contracts/render';
import type { SimEvent, SimEventType } from '@/core/contracts/sim';
import { fetchDefSource } from '@/core/defs/fetchSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import { acquireGpu } from '@/core/gpu/device';
import { installTestApi } from '@/core/testing/testApi';
import { createLabApi, type AudioLabApi } from './labApi';
import { LabEngines, labStack, placeVehicle, type LabPlacement, type LabStackId } from './labVehicle';
import { compose, externalAt, listener, makeEvent, SEA_LEVEL, type ListenerSpec } from './scenes';

declare global {
  interface Window {
    __audioLab?: AudioLabApi;
    __audioLabLive?: { set(partial: Partial<LiveState>): void; get(): LiveState; fire(type: SimEventType): void; ignite(): void; fireSolids(): void; shutdown(): void; updateCost(): { frames: number; p50: number; p99: number; max: number }; engine: FableAudioEngine };
  }
}

const params = new URLSearchParams(location.search);
const testApi = installTestApi({ kind: 'lab', name: 'audio', scenarioId: `fake-${params.get('scene') ?? 'pad'}` });

interface LiveState {
  scene: FakeScene;
  stack: string;
  throttle: number;
  /** Ambient pressure at the vessel (nozzles, hull), Pa. */
  pressure: number;
  q: number;
  mach: number;
  plasma: number;
  gLoad: number;
  kind: ViewKind;
  mode: string;
  distance: number;
  azimuthDeg: number;
  height: number;
  warpFactor: number;
  paused: boolean;
  volume: number;
  maxTempFraction: number;
}

const state: LiveState = {
  scene: (params.get('scene') as FakeScene | null) ?? 'pad',
  stack: params.get('stack') ?? 'booster',
  throttle: 0,
  pressure: SEA_LEVEL,
  q: 0,
  mach: 0,
  plasma: 0,
  gLoad: 1,
  kind: (params.get('kind') as ViewKind | null) ?? 'external',
  mode: params.get('mode') ?? 'chase',
  distance: 120,
  azimuthDeg: 35,
  height: 5,
  warpFactor: 1,
  paused: false,
  volume: 0.8,
  maxTempFraction: 0.2,
};

function stackPlacements(lib: DefLibrary, stack: string): { parts: LabPlacement[]; seat: { x: number; y: number; z: number } } {
  if (stack.startsWith('vehicle:')) return placeVehicle(lib, stack.slice('vehicle:'.length));
  const s = labStack(lib, stack as LabStackId);
  return { parts: s.parts, seat: s.seat };
}

const BUS_ORDER: AudioBusName[] = ['engines', 'aero', 'reentry', 'events', 'cabin', 'ui', 'master'];

function drawMeters(canvas: HTMLCanvasElement, probe: AudioProbe, peaks: Map<string, number>): void {
  const dpr = devicePixelRatio;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  g.fillStyle = '#07090d';
  g.fillRect(0, 0, cw, ch);
  const top = 110;
  const bottom = ch - 40;
  const span = bottom - top;
  const dbToY = (db: number): number => top + span * Math.min(1, Math.max(0, -db / 80));
  g.font = '11px ui-monospace, Consolas, monospace';
  g.strokeStyle = '#1a2130';
  g.fillStyle = '#5d6b85';
  for (let db = 0; db >= -80; db -= 10) {
    const y = dbToY(db);
    g.beginPath();
    g.moveTo(40, y);
    g.lineTo(cw - 16, y);
    g.stroke();
    g.fillText(`${db}`, 10, y + 4);
  }
  const colW = (cw - 60) / BUS_ORDER.length;
  BUS_ORDER.forEach((bus, i) => {
    const b = probe.buses[bus];
    const x0 = 50 + i * colW;
    const db = (a: number): number => (a > 0 ? 20 * Math.log10(a) : -120);
    const bars: [number, string][] = [
      [db(b.rms), bus === 'master' ? '#f2d27a' : '#5fb3f0'],
      [db(b.low), '#8a6df0'],
      [db(b.mid), '#55c99a'],
      [db(b.high), '#f08a5f'],
    ];
    const bw = Math.max(6, (colW - 24) / 4);
    bars.forEach(([v, col], k) => {
      const y = dbToY(v);
      g.fillStyle = col;
      g.fillRect(x0 + k * (bw + 2), y, bw, bottom - y);
    });
    const pk = Math.max(db(b.peak), (peaks.get(bus) ?? -120) - 0.5);
    peaks.set(bus, pk);
    g.fillStyle = pk > -1 ? '#ff4d4d' : '#ffffff';
    g.fillRect(x0, dbToY(pk) - 1, 4 * (bw + 2) - 2, 2);
    g.fillStyle = '#cfd6e4';
    g.fillText(bus, x0, bottom + 16);
    g.fillStyle = '#8fa3c4';
    g.fillText(`${db(b.rms).toFixed(1)} dB`, x0, bottom + 30);
  });
  g.fillStyle = '#5d6b85';
  g.fillText('bars per bus: rms | low <250 Hz | mid 250-2k | high >2k   (white tick = peak, dBFS)', 50, top - 14);
}

async function boot(): Promise<void> {
  const gpu = await acquireGpu({ onError: testApi.reportError });
  testApi.setAdapter(gpu.report);
  const lib = await loadDefs(fetchDefSource());
  const engine = createAudioEngine({ onError: testApi.reportError });
  await engine.init(lib, '/assets/audio');
  const config = engine.config!;
  window.__audioLab = createLabApi(config, lib, engine.bank!);
  testApi.extend({ audio: () => engine.probe() });

  // The first real user gesture starts sound (no autoplay assumptions).
  const gesture = (): void => {
    void engine.resume();
  };
  window.addEventListener('keydown', gesture);
  window.addEventListener('pointerdown', gesture);

  let sim = createFakeSim(lib, { scene: state.scene });
  let stack = stackPlacements(lib, state.stack);
  let engines = new LabEngines(stack.parts, lib.parts);
  const pending: SimEventType[] = [];
  /** Main-thread cost of AudioEngine.update over the last 600 frames, ms. */
  const updateMs: number[] = [];
  const rebuild = (): void => {
    sim = createFakeSim(lib, { scene: state.scene });
    stack = stackPlacements(lib, state.stack);
    engines = new LabEngines(stack.parts, lib.parts);
  };

  const live = {
    engine,
    set(partial: Partial<LiveState>) {
      const restack = (partial.stack !== undefined && partial.stack !== state.stack) || (partial.scene !== undefined && partial.scene !== state.scene);
      Object.assign(state, partial);
      if (restack) rebuild();
      syncControls();
    },
    get: () => ({ ...state }),
    updateCost() {
      const v = [...updateMs].sort((a, b) => a - b);
      const q = (p: number): number => v[Math.min(v.length - 1, Math.floor(p * v.length))] ?? 0;
      return { frames: v.length, p50: q(0.5), p99: q(0.99), max: v[v.length - 1] ?? 0 };
    },
    fire(type: SimEventType) {
      pending.push(type);
    },
    ignite() {
      engines.activate((p) => lib.parts[p.def]?.modules.some((m) => m.type === 'engine' && !m.fixedBurn) ?? false);
    },
    fireSolids() {
      engines.activate((p) => lib.parts[p.def]?.modules.some((m) => m.type === 'engine' && m.fixedBurn !== undefined) ?? false);
    },
    shutdown() {
      engines.shutdown(() => true);
    },
  };
  window.__audioLabLive = live;

  // ---------------------------------------------------------------------------------------- controls
  const panel = document.getElementById('controls')!;
  const syncers: (() => void)[] = [];
  const section = (title: string): void => {
    const h = document.createElement('h2');
    h.textContent = title;
    panel.appendChild(h);
  };
  const slider = (label: string, key: keyof LiveState, min: number, max: number, step: number, fmt: (v: number) => string, log = false): void => {
    const row = document.createElement('div');
    row.className = 'row';
    const l = document.createElement('label');
    l.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '1000';
    input.dataset['key'] = key;
    const val = document.createElement('span');
    val.className = 'val';
    const toV = (s: number): number => {
      const t = s / 1000;
      const v = log ? (t === 0 ? 0 : min * (max / min) ** t) : min + (max - min) * t;
      return Math.round(v / step) * step;
    };
    const fromV = (v: number): number => (log ? (v <= 0 ? 0 : (1000 * Math.log(v / min)) / Math.log(max / min)) : (1000 * (v - min)) / (max - min));
    input.addEventListener('input', () => {
      (state as unknown as Record<string, number>)[key] = toV(Number(input.value));
      val.textContent = fmt(state[key] as number);
    });
    syncers.push(() => {
      input.value = String(Math.round(fromV(state[key] as number)));
      val.textContent = fmt(state[key] as number);
    });
    row.append(l, input, val);
    panel.appendChild(row);
  };
  const select = (label: string, key: keyof LiveState, options: string[], onChange?: () => void): void => {
    const row = document.createElement('div');
    row.className = 'row';
    const l = document.createElement('label');
    l.textContent = label;
    const sel = document.createElement('select');
    sel.dataset['key'] = key;
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      const v = sel.value;
      (state as unknown as Record<string, unknown>)[key] = key === 'warpFactor' ? Number(v) : v;
      onChange?.();
    });
    syncers.push(() => {
      sel.value = String(state[key]);
    });
    row.append(l, sel, document.createElement('span'));
    panel.appendChild(row);
  };
  const button = (parent: HTMLElement, label: string, fn: () => void): void => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    parent.appendChild(b);
  };

  section('Scene');
  select('fake scene', 'scene', ['pad', 'ascent', 'lowOrbit', 'translunar', 'lunarOrbit', 'lunarSurface', 'reentry', 'chutes'], rebuild);
  const vehicleOptions = Object.keys(lib.vehicles).map((id) => `vehicle:${id}`);
  select('stack', 'stack', ['booster', 'upper', 'tli', 'lander', 'ascent', 'capsule', ...vehicleOptions], rebuild);
  const engineRow = document.createElement('div');
  engineRow.id = 'events';
  button(engineRow, 'ignite', () => live.ignite());
  button(engineRow, 'fire solids', () => live.fireSolids());
  button(engineRow, 'shutdown', () => live.shutdown());
  panel.appendChild(engineRow);
  slider('throttle', 'throttle', 0, 1, 0.01, (v) => `${(v * 100).toFixed(0)} %`);
  section('Environment');
  slider('pressure', 'pressure', 1, SEA_LEVEL, 1, (v) => (v < 1000 ? `${v.toFixed(0)} Pa` : `${(v / 1000).toFixed(1)} kPa`), true);
  slider('q', 'q', 0, 60000, 100, (v) => `${(v / 1000).toFixed(1)} kPa`);
  slider('mach', 'mach', 0, 30, 0.05, (v) => v.toFixed(2));
  slider('plasma', 'plasma', 0, 1, 0.01, (v) => v.toFixed(2));
  slider('g-load', 'gLoad', 0, 10, 0.05, (v) => `${v.toFixed(2)} g`);
  slider('max temp frac', 'maxTempFraction', 0, 1, 0.01, (v) => v.toFixed(2));
  section('Listener');
  select('kind', 'kind', ['interior', 'external', 'map']);
  const modeRow = document.createElement('div');
  modeRow.className = 'row';
  const modeLabel = document.createElement('label');
  modeLabel.textContent = 'mode';
  const modeInput = document.createElement('input');
  modeInput.type = 'text';
  modeInput.value = state.mode;
  modeInput.addEventListener('change', () => {
    state.mode = modeInput.value;
  });
  syncers.push(() => {
    modeInput.value = state.mode;
  });
  modeRow.append(modeLabel, modeInput, document.createElement('span'));
  panel.appendChild(modeRow);
  slider('distance', 'distance', 5, 5000, 1, (v) => `${v.toFixed(0)} m`, true);
  slider('azimuth', 'azimuthDeg', -180, 180, 1, (v) => `${v.toFixed(0)} deg`);
  slider('height', 'height', -100, 300, 1, (v) => `${v.toFixed(0)} m`);
  section('Time');
  select('warp', 'warpFactor', ['1', '2', '3', '4', '5', '10', '100', '1000']);
  const pauseRow = document.createElement('div');
  pauseRow.id = 'events';
  button(pauseRow, 'pause / resume', () => {
    state.paused = !state.paused;
  });
  panel.appendChild(pauseRow);
  slider('master volume', 'volume', 0, 1, 0.01, (v) => v.toFixed(2));
  section('Events');
  const ev = document.createElement('div');
  ev.id = 'events';
  for (const type of Object.keys(config.events) as SimEventType[]) button(ev, type, () => live.fire(type));
  panel.appendChild(ev);
  section('Offline');
  const off = document.createElement('div');
  off.id = 'events';
  for (const name of window.__audioLab.clipNames()) {
    button(off, `record ${name}.wav`, () => {
      void window.__audioLab!.clip(name).then((c) => {
        const a = document.createElement('a');
        a.href = `data:audio/wav;base64,${c.wav}`;
        a.download = `${name}.wav`;
        a.click();
      });
    });
  }
  panel.appendChild(off);
  const syncControls = (): void => {
    for (const s of syncers) s();
  };
  syncControls();

  // -------------------------------------------------------------------------------------------- loop
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const status = document.getElementById('status')!;
  const hint = document.getElementById('hint')!;
  const peaks = new Map<string, number>();
  let last = performance.now();
  const frame = (now: number): void => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!state.paused) {
      sim.advance(dt);
      engines.step(dt, state.throttle);
    }
    const base = sim.snapshot();
    const vesselId = base.activeVesselId;
    const events: SimEvent[] = pending.splice(0).map((type) => makeEvent(type, base.ut, vesselId, base, { partId: 'capsule' }));
    const snapshot = compose(
      base,
      {
        parts: engines.parts(state.pressure),
        aero: { pressure: state.pressure, q: state.q, mach: state.mach, plasmaIntensity: state.plasma },
        gLoad: state.gLoad,
        events,
        readouts: { maxTempFraction: state.maxTempFraction },
        warp: { factor: state.warpFactor, onRails: state.warpFactor > 4 },
        boundingRadius: 10,
      },
      0,
      base.tick,
    );
    snapshot.ut = base.ut;
    const az = (state.azimuthDeg * Math.PI) / 180;
    const spec: ListenerSpec =
      state.kind === 'interior'
        ? { kind: 'interior', mode: state.mode, position: stack.seat, pressure: state.pressure }
        : { ...externalAt(state.distance, { height: state.height, az, kind: state.kind, mode: state.mode, pressure: state.pressure }) };
    const audioFrame: AudioFrame = { snapshot, listener: listener(spec, vesselId), realDt: dt, warpFactor: state.warpFactor, paused: state.paused };
    const u0 = performance.now();
    engine.update(audioFrame);
    updateMs.push(performance.now() - u0);
    if (updateMs.length > 600) updateMs.shift();
    engine.setMasterVolume(state.volume);
    const probe = engine.probe();
    drawMeters(canvas, probe, peaks);
    const stats = engine.stats();
    status.textContent =
      `audio ${probe.state}   ${probe.sampleRate} Hz   assets ${probe.assetsLoaded}/${probe.assetsTotal}   voices ${probe.activeVoices}   engine voices ${stats?.engineVoices ?? 0}   nodes ${stats?.nodes ?? 0}   delay lines ${stats?.delayLines ?? 0}   output ${engine.status.output}\n` +
      `scene ${state.scene}   stack ${state.stack}   listener ${state.kind}/${state.mode} ${state.kind === 'interior' ? 'seat' : `${state.distance.toFixed(0)} m`}   p ${state.pressure.toFixed(0)} Pa   throttle ${(state.throttle * 100).toFixed(0)} %`;
    hint.textContent = probe.state === 'running' ? '' : 'press any key or click to start sound';
    testApi.frameDone();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  await testApi.api.waitFrames(2);
}

boot().then(
  () => testApi.markReady(true),
  (err: unknown) => {
    testApi.reportError(err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
    testApi.markReady(false);
  },
);
