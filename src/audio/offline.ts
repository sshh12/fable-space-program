/**
 * Offline rendering of the real graph: the same createAudioGraph + SoundModel as the live engine, driven
 * frame by frame through OfflineAudioContext.suspend(), with every bus, every path sub-mix and the master
 * output captured on separate channels. Used by the acceptance specs and to record listen-proof clips.
 */
import type { AudioFrame } from '@/core/contracts/audio';
import type { DefLibrary } from '@/core/contracts/defs';
import type { AudioConfig } from './config';
import { createAudioGraph, TAP_NAMES, type AssetBank, type TapName } from './graph';
import { SoundModel } from './model';

export interface OfflineRenderSpec {
  /** Seconds to render. */
  duration: number;
  sampleRate?: number;
  /** Frame cadence, rounded to whole 128-sample render quanta (default 60 Hz -> 6 quanta = 16 ms at 48 kHz). */
  frameRate?: number;
  /** The AudioFrame at render time t (s); dt is the time since the previous frame. */
  frame: (t: number, dt: number) => AudioFrame;
  /** Taps to capture as mono channels (default: all). The master is always captured in stereo. */
  taps?: TapName[];
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
  /** Mono (0.5 (L + R)) capture of each requested tap. */
  taps: Partial<Record<TapName, Float32Array>>;
  oneShots: OfflineOneShotLog[];
  problems: string[];
  /** Wall-clock render time, ms. */
  renderMs: number;
}

export async function renderOffline(config: AudioConfig, defs: DefLibrary, bank: AssetBank, spec: OfflineRenderSpec): Promise<OfflineRender> {
  const sampleRate = spec.sampleRate ?? 48000;
  const taps = (spec.taps ?? TAP_NAMES).filter((t) => t !== 'master');
  const length = Math.ceil(spec.duration * sampleRate);
  const channels = 2 + taps.length;
  if (channels > 32) throw new Error(`renderOffline: ${taps.length} taps exceed the 30-tap limit`);
  const ctx = new OfflineAudioContext({ numberOfChannels: channels, length, sampleRate });
  const problems: string[] = [];
  const graph = createAudioGraph(ctx, bank, config, { onProblem: (p) => problems.push(p), startTime: 0 });
  const model = new SoundModel(config, defs);
  if (spec.masterVolume !== undefined) graph.setMasterVolume(spec.masterVolume, 0);

  const merger = new ChannelMergerNode(ctx, { numberOfInputs: channels });
  const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
  graph.output.connect(split);
  split.connect(merger, 0, 0);
  split.connect(merger, 1, 1);
  taps.forEach((t, i) => graph.taps[t].connect(merger, 0, 2 + i));
  merger.connect(ctx.destination);

  const quantum = 128;
  const stepFrames = Math.max(1, Math.round(sampleRate / (spec.frameRate ?? 60) / quantum)) * quantum;
  const step = stepFrames / sampleRate;
  const frameTimes: number[] = [];
  const oneShots: OfflineOneShotLog[] = [];
  let lastT = -step;
  const applyAt = (t: number): void => {
    const frame = spec.frame(t, t - lastT);
    lastT = t;
    const out = model.update(frame);
    // Automation is scheduled at the suspension time itself (not ctx.currentTime, which the render thread
    // may already have moved on from), so renders are reproducible sample for sample.
    for (const r of out.oneShots) oneShots.push({ time: t, cause: r.cause, bus: r.bus, asset: r.asset });
    graph.apply(out, t);
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
  taps.forEach((t, i) => {
    out[t] = buffer.getChannelData(2 + i);
  });
  return { sampleRate, length, frameTimes, master: [buffer.getChannelData(0), buffer.getChannelData(1)], taps: out, oneShots, problems, renderMs };
}
