/**
 * window.__audioLab: offline renders of the real graph for the acceptance spec and the clip recorder.
 * Each call renders a script with renderOffline (same SoundModel + graph as the live engine) and returns
 * measurements computed in the page.
 */
import { audioAnalysis, renderOffline, SoundModel, TAP_NAMES, type AssetBank, type AudioConfig, type OfflineRender, type TapName } from '@/audio';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimEventType } from '@/core/contracts/sim';
import type { LabStackId } from './labVehicle';
import { clipStats, masterWavBase64, maxAbsDiff, measureRender, onset, onsetAbove, type ClipStats, type TapMeasure } from './measure';
import type { Script } from './scenes';
import { clipScripts, eventsScript, ignitionScript, maximumScript, modeScript, plasmaScript, steadyScript, type SteadyCase } from './scripts';

export interface MeasureResult {
  renderMs: number;
  taps: Record<string, TapMeasure>;
  problems: string[];
  oneShots: { time: number; cause: string; bus: string }[];
}

export interface AudioLabApi {
  eventTypes: SimEventType[];
  steady(c: SteadyCase, windows: [number, number][], taps: TapName[]): Promise<MeasureResult>;
  /** Onset of the ignition at `at` s in the given taps (relative to each tap's own maximum). */
  ignition(stack: LabStackId, distance: number, taps: TapName[], windows: [number, number][]): Promise<MeasureResult & { onsets: Record<string, number | null>; at: number }>;
  plasma(level: number, kind: 'interior' | 'external'): Promise<MeasureResult>;
  /** Each event type rendered on its own: onset of its one-shot on the events bus. */
  events(): Promise<MeasureResult & { schedule: { type: SimEventType; t: number }[]; onsets: { type: SimEventType; t: number; onset: number | null; silentBefore: boolean }[] }>;
  maximum(kind: 'interior' | 'external'): Promise<MeasureResult>;
  /** The same lift-off heard by an external camera with mode 'chase' and with an unknown mode of kind 'external'. */
  modes(unknownMode: string): Promise<{ modelIdentical: boolean; frames: number; masterDiff: number; selfMasterDiff: number; tapDiff: number; selfTapDiff: number; masterRms: number; enginesRms: number }>;
  clipNames(): string[];
  clip(name: string): Promise<{ wav: string; stats: ClipStats; renderMs: number; problems: string[] }>;
  /** Per-bus and per-path levels of a clip in the given windows (diagnosis of what is heard when). */
  clipTaps(name: string, windows: [number, number][]): Promise<MeasureResult>;
}

export function createLabApi(config: AudioConfig, defs: DefLibrary, bank: AssetBank): AudioLabApi {
  const render = (s: Script, taps?: TapName[]): Promise<OfflineRender> => renderOffline(config, defs, bank, { duration: s.duration, frame: s.frame, taps });
  const result = (r: OfflineRender, taps: TapName[], windows: [number, number][]): MeasureResult => ({
    renderMs: r.renderMs,
    taps: measureRender(r, taps, windows),
    problems: r.problems,
    oneShots: r.oneShots.map((o) => ({ time: o.time, cause: o.cause, bus: o.bus })),
  });
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
      let measured: MeasureResult['taps'] = {};
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
        measured = measureRender(r, taps, [[at, s.duration]]);
      }
      return { renderMs, taps: measured, problems, oneShots, schedule, onsets };
    },
    async maximum(kind) {
      const taps: TapName[] = ['master', 'engines', 'events', 'aero', 'reentry', 'cabin', 'ui'];
      return result(await render(maximumScript(defs, kind), taps.filter((t) => t !== 'master')), taps, [[0, 4]]);
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
      let tapDiff = 0;
      let selfTapDiff = 0;
      for (const t of taps) {
        tapDiff = Math.max(tapDiff, maxAbsDiff(a1.taps[t]!, b1.taps[t]!));
        selfTapDiff = Math.max(selfTapDiff, maxAbsDiff(a1.taps[t]!, a2.taps[t]!));
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
      return { wav: masterWavBase64(r), stats: clipStats(r), renderMs: r.renderMs, problems: r.problems };
    },
  };
}
