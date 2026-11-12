/**
 * window.__audioLab: offline renders of the real graph for the acceptance spec and the clip recorder.
 * Each call renders a script with renderOffline (same SoundModel + graph as the live engine) and returns
 * measurements computed in the page.
 */
import { audioAnalysis, BUS_NAMES, createAudioGraph, renderOffline, SoundModel, TAP_NAMES, type AssetBank, type AudioConfig, type AudioGraphStats, type OfflineRender, type TapName } from '@/audio';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimEventType } from '@/core/contracts/sim';
import { ENTRY_PROFILE, entryStateAt, missionEntryScript, type EntryState } from './entry';
import type { LabStackId } from './labVehicle';
import { clipStats, masterWavBase64, maxAbsDiff, measureRender, onset, onsetAbove, preCeilingLevels, type ClipStats, type TapMeasure } from './measure';
import type { Script } from './scenes';
import { clipScripts, eventsScript, ignitionScript, loudScripts, maximumScript, modeScript, plasmaScript, restartScript, steadyScript, type SteadyCase } from './scripts';

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
  /** The entry voice at a constant plasma intensity; `q` = dynamic pressure, Pa (default 0: the glow alone). */
  plasma(level: number, kind: 'interior' | 'external', q?: number): Promise<MeasureResult>;
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
  /**
   * The vehicle's engines lit, shut down and lit again (scripts.ts restartScript) rendered with the engine
   * voices built ahead (engines.standbyVoices as configured), with the voices built when they first sound
   * (0), and built ahead once more. tapDiff / selfTapDiff: largest max-abs difference of any audible tap
   * relative to that tap's RMS, ahead vs on demand / ahead vs ahead (the renderer's own floor).
   */
  standby(distance: number, stack?: LabStackId | 'vehicle'): Promise<{ shape: { tap: string; from: number; rmsA: number; rmsB: number; gain: number; residual: number; lag: number; residualAtLag: number }[]; worst: { tap: string; at: number; first: number; diff: number; self: number }[]; tapDiff: number; selfTapDiff: number; masterDiff: number; selfMasterDiff: number; masterRms: number; enginesRms: number; ahead: AudioGraphStats; onDemand: AudioGraphStats; renderMs: { ahead: number; onDemand: number }; problems: string[] }>;
  clipNames(): string[];
  clip(name: string): Promise<{ wav: string; stats: ClipStats; renderMs: number; problems: string[]; preCeiling: { peak: number; kneeShare: number }; maxStats: AudioGraphStats }>;
  /** Per-bus and per-path levels of a clip in the given windows (diagnosis of what is heard when). */
  clipTaps(name: string, windows: [number, number][]): Promise<MeasureResult>;
  /**
   * The mission's entry (labs/audio/entry.ts: the real Sim's capsule, entry interface to splashdown) heard
   * from the cabin or by a chase camera: one real-time render of `seconds` per start time (seconds into the
   * profile), measured from 1.5 s on. Per start: the flight state there and the RMS level, dBFS, of the
   * master and of every bus. `rules: 'plasmaOnly'` renders with the rules the game had before the entry fix
   * (the wind without a structure-borne share for the camera, the roar and the rumble driven by the glow
   * alone), for the before / after table of the acceptance spec.
   */
  entry(kind: 'interior' | 'external', starts: number[], seconds: number, rules?: 'current' | 'plasmaOnly'): Promise<{ marks: Record<string, number>; rows: EntryLevels[]; renderMs: number; problems: string[] }>;
}

export interface EntryLevels {
  from: number;
  state: EntryState;
  /** RMS over the window, dBFS: 'master' and each bus. */
  levels: Record<string, number>;
  oneShots: string[];
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
    async plasma(level, kind, q = 0) {
      const taps: TapName[] = ['reentry', 'reentry.air', 'reentry.body', 'master'];
      return result(await render(plasmaScript(defs, level, kind, q), taps.filter((t) => t !== 'master')), taps, [[1, 2.5]]);
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
    async standby(distance, stack = 'vehicle') {
      const taps = TAP_NAMES.filter((t) => t !== 'master');
      const onDemand: AudioConfig = { ...config, engines: { ...config.engines, standbyVoices: 0 } };
      // A script holds its engines' state: a fresh one per render.
      const run = (c: AudioConfig): Promise<OfflineRender> => {
        const s = restartScript(defs, distance, stack);
        return renderOffline(c, defs, bank, { duration: s.duration, frame: s.frame, taps });
      };
      const a1 = await run(config);
      const b = await run(onDemand);
      const a2 = await run(config);
      let tapDiff = 0;
      let selfTapDiff = 0;
      // Per audible tap: the largest difference relative to the tap's RMS and when it occurs, largest first.
      const worst: { tap: string; at: number; first: number; diff: number; self: number }[] = [];
      for (const t of taps) {
        const x = a1.taps[t]!;
        const y = b.taps[t]!;
        const rms = audioAnalysis.rmsOf(x);
        if (rms < 1e-6) continue;
        let at = 0;
        let most = 0;
        let first = -1;
        for (let i = 0; i < x.length; i++) {
          const d = Math.abs(x[i]! - y[i]!);
          if (first < 0 && d > 1e-3 * rms) first = i;
          if (d > most) {
            most = d;
            at = i;
          }
        }
        const self = maxAbsDiff(x, a2.taps[t]!) / rms;
        worst.push({ tap: t, at: at / a1.sampleRate, first: first / a1.sampleRate, diff: most / rms, self });
        tapDiff = Math.max(tapDiff, most / rms);
        selfTapDiff = Math.max(selfTapDiff, self);
      }
      worst.sort((p, q) => q.diff - p.diff);
      // What kind of difference it is, in windows of the engines' air and body paths: the gain that fits one
      // render to the other, what is left after it, and the shift (samples) at which the two agree best.
      const shape: { tap: string; from: number; rmsA: number; rmsB: number; gain: number; residual: number; lag: number; residualAtLag: number }[] = [];
      for (const t of ['engines.air', 'engines.body'] as TapName[]) {
        const x = a1.taps[t]!;
        const y = b.taps[t]!;
        for (const from of [0.6, 0.9, 1.5, 2.0, 10.4, 11.0]) {
          const i0 = Math.round(from * a1.sampleRate);
          const n = Math.round(0.25 * a1.sampleRate);
          let xx = 0;
          let yy = 0;
          let xy = 0;
          for (let i = i0; i < i0 + n; i++) {
            xx += x[i]! * x[i]!;
            yy += y[i]! * y[i]!;
            xy += x[i]! * y[i]!;
          }
          if (xx <= 0 || yy <= 0) continue;
          const gain = xy / yy;
          const residualOf = (lag: number, g: number): number => {
            let r = 0;
            for (let i = i0; i < i0 + n; i++) {
              const d = x[i]! - g * y[i + lag]!;
              r += d * d;
            }
            return Math.sqrt(r / xx);
          };
          let lag = 0;
          let best = residualOf(0, gain);
          for (let l = -48; l <= 48; l++) {
            const r = residualOf(l, 1);
            if (r < best) {
              best = r;
              lag = l;
            }
          }
          shape.push({ tap: t, from, rmsA: Math.sqrt(xx / n), rmsB: Math.sqrt(yy / n), gain, residual: residualOf(0, gain), lag, residualAtLag: best });
        }
      }
      const masterDiff = Math.max(maxAbsDiff(a1.master[0], b.master[0]), maxAbsDiff(a1.master[1], b.master[1]));
      const selfMasterDiff = Math.max(maxAbsDiff(a1.master[0], a2.master[0]), maxAbsDiff(a1.master[1], a2.master[1]));
      const m = measureRender(a1, ['master', 'engines'], [[0.5, 12]]);
      return {
        worst,
        shape,
        tapDiff,
        selfTapDiff,
        masterDiff,
        selfMasterDiff,
        masterRms: m['master']!.windows[0]!.rms,
        enginesRms: m['engines']!.windows[0]!.rms,
        ahead: a1.maxStats,
        onDemand: b.maxStats,
        renderMs: { ahead: a1.renderMs, onDemand: b.renderMs },
        problems: [...a1.problems, ...b.problems],
      };
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
    async entry(kind, starts, seconds, rules = 'current') {
      const taps: TapName[] = [...BUS_NAMES];
      const env = config.environment;
      const used: AudioConfig =
        rules === 'plasmaOnly'
          ? { ...config, environment: { ...env, aero: { ...env.aero, bodyGainDb: -Infinity }, reentry: { ...env.reentry, load: { ...env.reentry.load, qRef: Infinity } } } }
          : config;
      const rows: EntryLevels[] = [];
      const problems: string[] = [];
      let renderMs = 0;
      for (const from of starts) {
        const s = missionEntryScript(defs, { from, duration: seconds, kind });
        const r = await renderOffline(used, defs, bank, { duration: s.duration, frame: s.frame, taps });
        renderMs += r.renderMs;
        problems.push(...r.problems);
        const m = measureRender(r, ['master', ...taps], [[1.5, seconds]]);
        rows.push({
          from,
          state: entryStateAt(ENTRY_PROFILE, from + 0.5 * seconds),
          levels: Object.fromEntries(Object.entries(m).map(([tap, v]) => [tap, v.windows[0]!.rmsDb])),
          oneShots: r.oneShots.map((o) => o.cause),
        });
      }
      return { marks: ENTRY_PROFILE.marks, rows, renderMs, problems };
    },
    async clip(name) {
      const s = clipScripts(defs).find((x) => x.name === name);
      if (!s) throw new Error(`unknown clip ${name}`);
      const r = await render(s, []);
      return { wav: masterWavBase64(r), stats: clipStats(r), renderMs: r.renderMs, problems: r.problems, preCeiling: preCeilingLevels(r, linearUntil), maxStats: r.maxStats };
    },
  };
}
