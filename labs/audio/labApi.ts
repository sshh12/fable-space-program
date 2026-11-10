/**
 * window.__audioLab: offline renders of the real graph for the acceptance spec and the clip recorder.
 * Each call renders a script with renderOffline (same SoundModel + graph as the live engine) and returns
 * measurements computed in the page.
 */
import { audioAnalysis, BUS_NAMES, createAudioGraph, renderOffline, SoundModel, TAP_NAMES, type AssetBank, type AudioConfig, type AudioGraphStats, type OfflineRender, type TapName } from '@/audio';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimEventType } from '@/core/contracts/sim';
import type { LabStackId } from './labVehicle';
import { clipStats, masterWavBase64, maxAbsDiff, measureRender, onset, onsetAbove, preCeilingLevels, type ClipStats, type TapMeasure } from './measure';
import type { Script } from './scenes';
import { clipScripts, eventsScript, ignitionScript, loudScripts, maximumScript, modeScript, plasmaScript, steadyScript, type SteadyCase } from './scripts';

export interface MeasureResult {
  renderMs: number;
  taps: Record<string, TapMeasure>;
  problems: string[];
  oneShots: { time: number; cause: string; bus: string }[];
  /** Master before its soft ceiling: peak and share of samples above mix.master.linearUntil. */
  preCeiling: { peak: number; kneeShare: number };
  maxStats: AudioGraphStats;
}

export interface HeadroomResult extends MeasureResult {
  name: string;
  /** True stereo sample peak of every bus. */
  busPeaks: Record<string, number>;
}

export interface AudioLabApi {
  eventTypes: SimEventType[];
  steady(c: SteadyCase, windows: [number, number][], taps: TapName[]): Promise<MeasureResult>;
  /** Onset of the ignition at `at` s in the given taps (relative to each tap's own maximum). */
  ignition(stack: LabStackId, distance: number, taps: TapName[], windows: [number, number][]): Promise<MeasureResult & { onsets: Record<string, number | null>; at: number }>;
  plasma(level: number, kind: 'interior' | 'external'): Promise<MeasureResult>;
  /** Each event type rendered on its own: onset of its one-shot on the events bus. */
  events(): Promise<MeasureResult & { schedule: { type: SimEventType; t: number }[]; onsets: { type: SimEventType; t: number; onset: number | null; silentBefore: boolean }[] }>;
  /** Everything at maximum: true bus peaks, the pre-ceiling master and the master. */
  maximum(kind: 'interior' | 'external'): Promise<HeadroomResult>;
  /** The loudest realistic scenes (booster at 25 / 50 m, its ignition at 25 m, from the cabin, every loud event at once). */
  loud(): Promise<HeadroomResult[]>;
  /** Small-signal gain of the master section (a quiet 1 kHz sine into the master input), dB, and what mix.json says it is. */
  masterGain(): Promise<{ measuredDb: number; expectedDb: number }>;
  /** The same lift-off heard by an external camera with mode 'chase' and with an unknown mode of kind 'external'. */
  /** tapDiff / selfTapDiff: largest max-abs difference of any audible tap relative to that tap's RMS (unknown mode vs chase / chase vs chase). */
  modes(unknownMode: string): Promise<{ modelIdentical: boolean; frames: number; masterDiff: number; selfMasterDiff: number; tapDiff: number; selfTapDiff: number; masterRms: number; enginesRms: number }>;
  clipNames(): string[];
  clip(name: string): Promise<{ wav: string; stats: ClipStats; renderMs: number; problems: string[]; preCeiling: { peak: number; kneeShare: number }; maxStats: AudioGraphStats }>;
  /** Per-bus and per-path levels of a clip in the given windows (diagnosis of what is heard when). */
  clipTaps(name: string, windows: [number, number][]): Promise<MeasureResult>;
}

export function createLabApi(config: AudioConfig, defs: DefLibrary, bank: AssetBank): AudioLabApi {
  const render = (s: Script, taps?: TapName[], stereoTaps = false): Promise<OfflineRender> => renderOffline(config, defs, bank, { duration: s.duration, frame: s.frame, taps, stereoTaps });
  const linearUntil = config.mix.master.linearUntil;
  const result = (r: OfflineRender, taps: TapName[], windows: [number, number][]): MeasureResult => ({
    renderMs: r.renderMs,
    taps: measureRender(r, taps, windows),
    problems: r.problems,
    oneShots: r.oneShots.map((o) => ({ time: o.time, cause: o.cause, bus: o.bus })),
    preCeiling: preCeilingLevels(r, linearUntil),
    maxStats: r.maxStats,
  });
  const headroom = async (s: Script): Promise<HeadroomResult> => {
    const taps: TapName[] = ['master', ...BUS_NAMES];
    const r = result(await render(s, [...BUS_NAMES], true), taps, [[0, s.duration]]);
    return { ...r, name: s.name, busPeaks: Object.fromEntries(BUS_NAMES.map((b) => [b, r.taps[b]!.maxAbs])) };
  };
  const eventTypes = Object.keys(config.events) as SimEventType[];
  return {
    eventTypes,
    async steady(c, windows, taps) {
      const s = steadyScript(defs, c);
      return result(await render(s, taps.filter((t) => t !== 'master')), taps, windows);
    },
    async ignition(stack, distance, taps, windows) {
      const at = 0.3;
      const s = ignitionScript(defs, stack, distance, at, distance > 1000 ? 9 : 4);
      const r = await render(s, taps.filter((t) => t !== 'master'));
      const onsets: Record<string, number | null> = {};
      for (const t of taps) onsets[t] = onset(r, t, { from: 0, fraction: 0.01, win: 0.002 });
      return { ...result(r, taps, windows), onsets, at };
    },
    async plasma(level, kind) {
      const taps: TapName[] = ['reentry', 'reentry.air', 'reentry.body', 'master'];
      return result(await render(plasmaScript(defs, level, kind), taps.filter((t) => t !== 'master')), taps, [[1, 2.5]]);
    },
    async events() {
      // One short render per event type, so no earlier one-shot is still ringing when the next is measured.
      const taps: TapName[] = ['events', 'events.air', 'events.body', 'events.direct'];
      const schedule: { type: SimEventType; t: number }[] = [];
      const onsets: { type: SimEventType; t: number; onset: number | null; silentBefore: boolean }[] = [];
      const oneShots: MeasureResult['oneShots'] = [];
      const problems: string[] = [];
      let renderMs = 0;
      let last: MeasureResult | null = null;
      for (const type of eventTypes) {
        const s = eventsScript(defs, [type], 1);
        const at = s.schedule[0]!.t;
        const r = await render(s, taps);
        renderMs += r.renderMs;
        problems.push(...r.problems);
        oneShots.push(...r.oneShots.map((o) => ({ time: o.time, cause: o.cause, bus: o.bus })));
        const before = audioAnalysis.peakOf(r.taps['events']!, 0, Math.round(at * r.sampleRate));
        schedule.push({ type, t: at });
        onsets.push({ type, t: at, onset: onsetAbove(r, 'events', 0, s.duration, 1e-4), silentBefore: before === 0 });
        last = result(r, taps, [[at, s.duration]]);
      }
      return { ...last!, renderMs, problems, oneShots, schedule, onsets };
    },
    maximum: (kind) => headroom(maximumScript(defs, kind)),
    async loud() {
      const out: HeadroomResult[] = [];
      for (const s of loudScripts(defs)) out.push(await headroom(s));
      return out;
    },
    async masterGain() {
      const sr = 48000;
      const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: sr * 1.5, sampleRate: sr });
      const graph = createAudioGraph(ctx, bank, config, { startTime: 0 });
      // -50 dBFS: far below the compressor threshold.
      const amp = 10 ** (-50 / 20) * Math.SQRT2;
      const osc = new OscillatorNode(ctx, { frequency: 1000 });
      const g = new GainNode(ctx, { gain: amp });
      osc.connect(g).connect(graph.masterInput);
      osc.start(0);
      graph.output.connect(ctx.destination);
      const out = await ctx.startRendering();
      graph.dispose();
      const L = out.getChannelData(0);
      const rms = audioAnalysis.rmsOf(L, Math.round(0.5 * sr), L.length);
      // A mono source into a stereo master: each side carries it at full level.
      return { measuredDb: audioAnalysis.toDb(rms) + 50, expectedDb: config.mix.master.gainDb + config.mix.master.compressor.makeupDb };
    },
    async modes(unknownMode) {
      // 1. The sound model's targets for the whole timeline: must be identical, value for value.
      const sequence = (mode: string): string[] => {
        const s = modeScript(defs, mode);
        const model = new SoundModel(config, defs);
        const out: string[] = [];
        const step = 768 / 48000;
        for (let t = 0, prev = -step; t < s.duration; prev = t, t += step) out.push(JSON.stringify(model.update(s.frame(t, t - prev))));
        return out;
      };
      const ma = sequence('chase');
      const mb = sequence(unknownMode);
      const modelIdentical = ma.length === mb.length && ma.every((x, i) => x === mb[i]);
      // 2. The rendered audio: chase vs unknown mode, and chase vs chase (the renderer's own noise floor).
      const taps = TAP_NAMES.filter((t) => t !== 'master');
      const a1 = await render(modeScript(defs, 'chase'), taps);
      const b1 = await render(modeScript(defs, unknownMode), taps);
      const a2 = await render(modeScript(defs, 'chase'), taps);
      // Per tap, relative to that tap's own RMS (taps before and after the bus gains differ by tens of dB).
      let tapDiff = 0;
      let selfTapDiff = 0;
      for (const t of taps) {
        const rms = audioAnalysis.rmsOf(a1.taps[t]!);
        if (rms < 1e-6) continue;
        tapDiff = Math.max(tapDiff, maxAbsDiff(a1.taps[t]!, b1.taps[t]!) / rms);
        selfTapDiff = Math.max(selfTapDiff, maxAbsDiff(a1.taps[t]!, a2.taps[t]!) / rms);
      }
      const masterDiff = Math.max(maxAbsDiff(a1.master[0], b1.master[0]), maxAbsDiff(a1.master[1], b1.master[1]));
      const selfMasterDiff = Math.max(maxAbsDiff(a1.master[0], a2.master[0]), maxAbsDiff(a1.master[1], a2.master[1]));
      const m = measureRender(a1, ['master', 'engines'], [[1, 6]]);
      return { modelIdentical, frames: ma.length, masterDiff, selfMasterDiff, tapDiff, selfTapDiff, masterRms: m['master']!.windows[0]!.rms, enginesRms: m['engines']!.windows[0]!.rms };
    },
    clipNames() {
      return clipScripts(defs).map((s) => s.name);
    },
    async clipTaps(name, windows) {
      const s = clipScripts(defs).find((x) => x.name === name);
      if (!s) throw new Error(`unknown clip ${name}`);
      const taps = TAP_NAMES.filter((t) => t !== 'master');
      return result(await render(s, taps), ['master', ...taps], windows);
    },
    async clip(name) {
      const s = clipScripts(defs).find((x) => x.name === name);
      if (!s) throw new Error(`unknown clip ${name}`);
      const r = await render(s, []);
      return { wav: masterWavBase64(r), stats: clipStats(r), renderMs: r.renderMs, problems: r.problems, preCeiling: preCeilingLevels(r, linearUntil), maxStats: r.maxStats };
    },
  };
}
