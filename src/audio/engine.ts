/**
 * The live AudioEngine (contract: src/core/contracts/audio.ts).
 *
 * Life cycle: init() parses and validates the audio sections of the DefLibrary, creates the AudioContext
 * and immediately holds it suspended (even where the browser's autoplay policy would let it run), decodes
 * every asset and builds the graph; resume() - called from the first real user gesture - starts sound.
 * A machine without an audio output device is tolerated: the context is then created (or re-routed) with
 * `sinkId: { type: 'none' }` so the graph still renders silently and probes keep working; if no context
 * can be created at all the engine stays silent with probe().state 'closed', and says why in `status`.
 */
import type { AudioBusName, AudioEngine, AudioFrame, AudioProbe } from '@/core/contracts/audio';
import type { DefLibrary } from '@/core/contracts/defs';
import { levelsFromAnalyser, SILENT_LEVELS, type Levels } from './analysis';
import { loadAssetBank } from './assets';
import { BUS_NAMES, parseAudioConfig, type AudioConfig } from './config';
import { createAudioGraph, type AssetBank, type AudioGraph } from './graph';
import { SoundModel } from './model';

export interface AudioEngineOptions {
  /** Creates the live context (tests inject failures here). Default: new AudioContext({ latencyHint: 'interactive', ...opts }). */
  createContext?: (opts: AudioContextOptions) => AudioContext;
  /** Receives model problems (e.g. a part with no definition) and failures to resume. */
  onError?: (message: string) => void;
}

export interface AudioEngineStatus {
  /** 'device' = normal output; 'none' = rendering to no device (sinkId none); 'unavailable' = no context. */
  output: 'device' | 'none' | 'unavailable';
  message: string | null;
}

/** The engine plus read-only handles that labs and offline renders reuse (config, decoded assets). */
export interface FableAudioEngine extends AudioEngine {
  readonly config: AudioConfig | null;
  readonly bank: AssetBank | null;
  readonly defs: DefLibrary | null;
  readonly status: AudioEngineStatus;
  /** The live context once init() has run (null when none could be created). */
  readonly context: AudioContext | null;
}

const PROBE_FFT = 2048;
const ALL_BUSES: AudioBusName[] = [...BUS_NAMES, 'master'];

type SinkIdOption = { sinkId?: string | { type: 'none' } };

function analyserLevels(a: AnalyserNode, time: Float32Array<ArrayBuffer>, freq: Float32Array<ArrayBuffer>): Levels {
  a.getFloatTimeDomainData(time);
  a.getFloatFrequencyData(freq);
  return levelsFromAnalyser(time, freq, a.context.sampleRate);
}

export function createAudioEngine(options: AudioEngineOptions = {}): FableAudioEngine {
  const make = options.createContext ?? ((o: AudioContextOptions) => new AudioContext(o));
  let ctx: AudioContext | null = null;
  let config: AudioConfig | null = null;
  let defsRef: DefLibrary | null = null;
  let bank: AssetBank | null = null;
  let graph: AudioGraph | null = null;
  let model: SoundModel | null = null;
  let analysers: Partial<Record<AudioBusName, AnalyserNode>> = {};
  let assetsLoaded = 0;
  let assetsTotal = 0;
  let resumeWanted = false;
  let volume = 1;
  let disposed = false;
  const status: AudioEngineStatus = { output: 'device', message: null };
  const timeBuf = new Float32Array(PROBE_FFT);
  const freqBuf = new Float32Array(PROBE_FFT / 2);

  const createContext = (): AudioContext | null => {
    try {
      return make({ latencyHint: 'interactive' });
    } catch (e) {
      status.message = `no audio output device (${e instanceof Error ? e.message : String(e)}); rendering without a sink`;
    }
    try {
      const c = make({ latencyHint: 'interactive', sinkId: { type: 'none' } } as AudioContextOptions & SinkIdOption);
      status.output = 'none';
      return c;
    } catch (e) {
      status.output = 'unavailable';
      status.message = `audio unavailable: ${e instanceof Error ? e.message : String(e)}`;
      return null;
    }
  };

  /** Re-route a context whose device failed to the null sink so it keeps rendering (probes, timing). */
  const toNullSink = async (c: AudioContext, why: string): Promise<void> => {
    const withSink = c as AudioContext & { setSinkId?: (id: { type: 'none' }) => Promise<void> };
    if (typeof withSink.setSinkId !== 'function') {
      status.message = `${why}; this browser cannot render without a device`;
      return;
    }
    try {
      await withSink.setSinkId({ type: 'none' });
      status.output = 'none';
      status.message = `${why}; rendering without a sink`;
    } catch (e) {
      status.message = `${why}; null sink failed (${e instanceof Error ? e.message : String(e)})`;
    }
  };

  const engine: FableAudioEngine = {
    get config() {
      return config;
    },
    get bank() {
      return bank;
    },
    get defs() {
      return defsRef;
    },
    get status() {
      return status;
    },
    get context() {
      return ctx;
    },

    async init(defs, assetsUrl) {
      if (config) throw new Error('AudioEngine.init called twice');
      config = parseAudioConfig(defs);
      defsRef = defs;
      assetsTotal = Object.keys(config.assets).length;
      ctx = createContext();
      if (ctx && ctx.state === 'running' && !resumeWanted) await ctx.suspend();
      ctx?.addEventListener('error', () => {
        if (ctx) void toNullSink(ctx, 'audio device error');
      });
      const decodeCtx: BaseAudioContext = ctx ?? new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: 48000 });
      bank = await loadAssetBank(decodeCtx, config, assetsUrl, (p) => {
        assetsLoaded = p.loaded;
      });
      if (disposed || !ctx) return;
      graph = createAudioGraph(ctx, bank, config, { onProblem: (m) => options.onError?.(`audio: ${m}`) });
      graph.output.connect(ctx.destination);
      analysers = {};
      for (const b of ALL_BUSES) {
        const a = new AnalyserNode(ctx, { fftSize: PROBE_FFT, smoothingTimeConstant: 0 });
        graph.taps[b].connect(a);
        analysers[b] = a;
      }
      graph.setMasterVolume(volume, ctx.currentTime);
      model = new SoundModel(config, defs);
      if (resumeWanted) await engine.resume();
    },

    async resume() {
      resumeWanted = true;
      const c = ctx;
      if (!c || c.state === 'running' || c.state === 'closed') return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        c.resume().then(
          () => 'resumed' as const,
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        ),
        new Promise<'timeout'>((r) => {
          timer = setTimeout(() => r('timeout'), 3000);
        }),
      ]);
      clearTimeout(timer);
      if (settled !== 'resumed' && (c.state as AudioContextState) !== 'running') {
        await toNullSink(c, `resume failed (${settled})`);
        await c.resume().catch((e: unknown) => options.onError?.(`audio: resume failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },

    update(frame: AudioFrame) {
      if (!graph || !model || !ctx) return;
      const out = model.update(frame);
      // One-shots requested while the context is suspended would all fire at once on resume: drop them.
      if (ctx.state !== 'running') out.oneShots = [];
      graph.apply(out, ctx.currentTime);
    },

    setMasterVolume(v: number) {
      volume = Math.max(0, v);
      if (graph && ctx) graph.setMasterVolume(volume, ctx.currentTime);
    },

    probe(): AudioProbe {
      const buses = {} as AudioProbe['buses'];
      for (const b of ALL_BUSES) {
        const a = analysers[b];
        buses[b] = a ? analyserLevels(a, timeBuf, freqBuf) : { ...SILENT_LEVELS };
      }
      return {
        state: ctx ? ctx.state : config ? 'closed' : 'uninitialised',
        sampleRate: ctx?.sampleRate ?? 0,
        buses,
        assetsLoaded,
        assetsTotal,
        activeVoices: graph?.activeVoices() ?? 0,
      };
    },

    dispose() {
      disposed = true;
      graph?.dispose();
      graph = null;
      model = null;
      const c = ctx;
      ctx = null;
      if (c && c.state !== 'closed') void c.close();
    },
  };
  return engine;
}
