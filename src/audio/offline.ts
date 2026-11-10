/**
 * Offline rendering of the real graph: the same createAudioGraph + SoundModel as the live engine, driven
 * frame by frame through OfflineAudioContext.suspend(), with every bus, every path sub-mix, the master
 * output and the master before its soft ceiling captured on separate channels. Used by the acceptance
 * specs and to record listen-proof clips.
 */
import type { AudioFrame } from '@/core/contracts/audio';
import type { DefLibrary } from '@/core/contracts/defs';
import type { AudioConfig } from './config';
import { createAudioGraph, TAP_NAMES, type AssetBank, type AudioGraphStats, type TapName } from './graph';
import { SoundModel } from './model';

export interface OfflineRenderSpec {
  /** Seconds to render. */
  duration: number;
  sampleRate?: number;
  /** Frame cadence, rounded to whole 128-sample render quanta (default 60 Hz -> 6 quanta = 16 ms at 48 kHz). */
  frameRate?: number;
  /** The AudioFrame at render time t (s); dt is the time since the previous frame. */
  frame: (t: number, dt: number) => AudioFrame;
  /** Taps to capture (default: all). The master and the pre-ceiling master are always captured in stereo. */
  taps?: TapName[];
  /** Capture each tap as a stereo pair (true sample peaks of panned buses; at most 14 taps). Default mono. */
  stereoTaps?: boolean;
  masterVolume?: number;
}

export interface OfflineOneShotLog {
  time: number;
  cause: string;
  bus: string;
  asset: string;
}

export interface OfflineRender {
  sampleRate: number;
  length: number;
  /** Times at which frames were applied. */
  frameTimes: number[];
  master: [Float32Array, Float32Array];
  /** The master after compressor and limiter, before the soft ceiling (what the ceiling is fed). */
  preCeiling: [Float32Array, Float32Array];
  /** Mono (0.5 (L + R)) capture of each requested tap. */
  taps: Partial<Record<TapName, Float32Array>>;
  /** Stereo capture of each requested tap (stereoTaps only). */
  stereo: Partial<Record<TapName, [Float32Array, Float32Array]>>;
  oneShots: OfflineOneShotLog[];
  problems: string[];
  /** Graph resource load sampled at every frame: the largest values seen. */
  maxStats: AudioGraphStats;
  /** Wall-clock render time, ms. */
  renderMs: number;
}

export async function renderOffline(config: AudioConfig, defs: DefLibrary, bank: AssetBank, spec: OfflineRenderSpec): Promise<OfflineRender> {
  const sampleRate = spec.sampleRate ?? 48000;
  const taps = (spec.taps ?? TAP_NAMES).filter((t) => t !== 'master');
  const perTap = spec.stereoTaps ? 2 : 1;
  const length = Math.ceil(spec.duration * sampleRate);
  const channels = 4 + perTap * taps.length;
  if (channels > 32) throw new Error(`renderOffline: ${taps.length} ${spec.stereoTaps ? 'stereo' : 'mono'} taps exceed the 28-channel limit`);
  const ctx = new OfflineAudioContext({ numberOfChannels: channels, length, sampleRate });
  const problems: string[] = [];
  const graph = createAudioGraph(ctx, bank, config, { onProblem: (p) => problems.push(p), startTime: 0 });
  const model = new SoundModel(config, defs);
  if (spec.masterVolume !== undefined) graph.setMasterVolume(spec.masterVolume, 0);

  const merger = new ChannelMergerNode(ctx, { numberOfInputs: channels });
  const stereoInto = (node: AudioNode, first: number): void => {
    const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    // Force a stereo view of the tap (a mono node is up-mixed to both sides).
    const up = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    node.connect(up).connect(split);
    split.connect(merger, 0, first);
    split.connect(merger, 1, first + 1);
  };
  stereoInto(graph.output, 0);
  stereoInto(graph.preCeiling, 2);
  taps.forEach((t, i) => {
    if (spec.stereoTaps) stereoInto(graph.taps[t], 4 + 2 * i);
    else graph.taps[t].connect(merger, 0, 4 + i);
  });
  merger.connect(ctx.destination);

  const quantum = 128;
  const stepFrames = Math.max(1, Math.round(sampleRate / (spec.frameRate ?? 60) / quantum)) * quantum;
  const step = stepFrames / sampleRate;
  const frameTimes: number[] = [];
  const oneShots: OfflineOneShotLog[] = [];
  const maxStats: AudioGraphStats = { engineVoices: 0, nodes: 0, delayLines: 0, delayLineSeconds: 0, oneShots: 0 };
  let lastT = -step;
  const applyAt = (t: number): void => {
    const frame = spec.frame(t, t - lastT);
    lastT = t;
    const out = model.update(frame);
    // Automation is scheduled at the suspension time itself (not ctx.currentTime, which the render thread
    // may already have moved on from), so renders are reproducible sample for sample.
    for (const r of out.oneShots) oneShots.push({ time: t, cause: r.cause, bus: r.bus, asset: r.asset });
    graph.apply(out, t);
    const s = graph.stats();
    for (const k of Object.keys(maxStats) as (keyof AudioGraphStats)[]) maxStats[k] = Math.max(maxStats[k], s[k]);
    frameTimes.push(ctx.currentTime);
  };
  let failure: unknown = null;
  for (let k = 1; k * stepFrames < length; k++) {
    const t = (k * stepFrames) / sampleRate;
    ctx
      .suspend(t)
      .then(() => {
        try {
          applyAt(t);
        } catch (e) {
          failure ??= e;
        }
        return ctx.resume();
      })
      .catch((e: unknown) => {
        failure ??= e;
      });
  }
  applyAt(0);
  const t0 = performance.now();
  const buffer = await ctx.startRendering();
  const renderMs = performance.now() - t0;
  graph.dispose();
  if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  const out: OfflineRender['taps'] = {};
  const stereo: OfflineRender['stereo'] = {};
  taps.forEach((t, i) => {
    if (spec.stereoTaps) {
      const L = buffer.getChannelData(4 + 2 * i);
      const R = buffer.getChannelData(5 + 2 * i);
      const mono = new Float32Array(L.length);
      for (let j = 0; j < L.length; j++) mono[j] = 0.5 * (L[j]! + R[j]!);
      stereo[t] = [L, R];
      out[t] = mono;
    } else out[t] = buffer.getChannelData(4 + i);
  });
  return {
    sampleRate,
    length,
    frameTimes,
    master: [buffer.getChannelData(0), buffer.getChannelData(1)],
    preCeiling: [buffer.getChannelData(2), buffer.getChannelData(3)],
    taps: out,
    stereo,
    oneShots,
    problems,
    maxStats,
    renderMs,
  };
}
