/**
 * The audio graph, built by a factory over ANY BaseAudioContext so that exactly the same nodes run live
 * (AudioContext) and offline in tests (OfflineAudioContext). The graph only applies the targets the
 * sound model computes (model.ts); it holds no game logic.
 *
 *   voice layers -> voice sum -+-> airborne: mono -> delay (propagation, Doppler) -> gain -> 2x low-pass -> panner -> bus.air
 *                              +-> structure-borne: 2x low-pass -> resonance -> gain ------------------------> bus.body
 *   one-shots: the same two paths (airborne copy started `delay` later), or bus.direct for feedback sounds
 *   bus.air + bus.body + bus.direct -> bus.sum (bus gain) -> bus.fade (time-warp fade) -> bus.out -> master
 *   master: volume -> pause -> compressor -> limiter (+ makeup cancel) = preCeiling -> soft ceiling -> out
 *
 * Engine voices exist only while their cluster sounds (the model emits them) and until their delay line
 * and transients have drained after that; a cluster that sounds again revives its draining voice.
 */
import type { AudioConfig, BusId, MixConfig } from './config';
import { BUS_NAMES } from './config';
import { compressorMakeupDb, dbToGain } from './mapping';
import { ambienceAssetIds, type AeroTarget, type AmbienceTarget, type CabinTarget, type EngineVoiceTarget, type ModelOutput, type OneShotRequest, type ReentryTarget, type SourcePaths } from './model';
import { CRACKLE_LEVELS, crackleWeights, noiseBank, noiseSource, slowModulator, type NoiseBank } from './noise';

/** Decoded sound assets by id (audio/assets.json), plus procedurally rendered ones. */
export interface AssetBank {
  buffers: Map<string, AudioBuffer>;
}

export type PathName = 'air' | 'body' | 'direct';
export type TapName = 'master' | BusId | `${BusId}.${PathName}`;

/** All tap names in a fixed order (offline renders put them on consecutive channels). */
export const TAP_NAMES: TapName[] = ['master', ...BUS_NAMES.flatMap((b) => [b, `${b}.air`, `${b}.body`, `${b}.direct`] as TapName[])];

type Smoothing = MixConfig['smoothing'];

/** An AudioParam driven toward per-frame targets; reaches an exact 0 when asked for 0. */
class Smooth {
  private last: number;
  constructor(
    readonly param: AudioParam,
    initial: number,
  ) {
    param.value = initial;
    this.last = initial;
  }
  get target(): number {
    return this.last;
  }
  set(target: number, time: number, tc: number): void {
    if (target === this.last) return;
    this.last = target;
    this.param.cancelAndHoldAtTime(time);
    if (target === 0) this.param.linearRampToValueAtTime(0, time + Math.max(0.004, 3 * tc));
    else this.param.setTargetAtTime(target, time, tc);
  }
  ramp(target: number, time: number, duration: number): void {
    if (target === this.last) return;
    this.last = target;
    this.param.cancelAndHoldAtTime(time);
    this.param.linearRampToValueAtTime(target, time + duration);
  }
  jump(target: number, time: number): void {
    this.last = target;
    this.param.cancelAndHoldAtTime(time);
    this.param.setValueAtTime(target, time);
  }
  /** Linear ramp from the current value to `target` over `duration` (used after a duck). */
  rampFromHold(target: number, time: number, duration: number): void {
    this.last = target;
    this.param.cancelAndHoldAtTime(time);
    this.param.linearRampToValueAtTime(target, time + duration);
  }
}

interface BusNodes {
  air: GainNode;
  body: GainNode;
  direct: GainNode;
  sum: GainNode;
  /** Bus gain: mix.json gainDb outside, interiorGainDb for the cabin mix. */
  sumParam: Smooth;
  fade: GainNode;
  fadeParam: Smooth;
  out: GainNode;
}

const NYQUIST_MARGIN = 0.45;

function lowpass(ctx: BaseAudioContext, hz: number, q = Math.SQRT1_2): BiquadFilterNode {
  return new BiquadFilterNode(ctx, { type: 'lowpass', frequency: Math.min(hz, ctx.sampleRate * NYQUIST_MARGIN), Q: q });
}
function highpass(ctx: BaseAudioContext, hz: number, q = Math.SQRT1_2): BiquadFilterNode {
  return new BiquadFilterNode(ctx, { type: 'highpass', frequency: Math.min(hz, ctx.sampleRate * NYQUIST_MARGIN), Q: q });
}

/** Seconds the airborne path is ducked around a delay-line jump (camera cut). */
const JUMP_DUCK = 0.02;

/** The two propagation paths of one continuous source. */
class PathOut {
  readonly input: GainNode;
  private readonly airGain: Smooth;
  private readonly airLp1: Smooth;
  private readonly airLp2: Smooth;
  private readonly px: Smooth;
  private readonly py: Smooth;
  private readonly pz: Smooth;
  private readonly delayParam: Smooth;
  private readonly bodyGain: Smooth;
  private readonly bodyLp1: Smooth;
  private readonly bodyLp2: Smooth;
  private readonly nodes: AudioNode[];
  private first = true;
  /** A delay-line jump waiting for the duck to complete. */
  private pendingJumpAt: number | null = null;
  lastDelay = 0;
  /** Seconds of delay line this path holds (one channel: the airborne branch is mono). */
  readonly delaySeconds: number;

  constructor(
    private readonly ctx: BaseAudioContext,
    bus: BusNodes,
    maxDelay: number,
    resonance: { hz: number; db: number } | null,
  ) {
    this.input = new GainNode(ctx, { gain: 1 });
    // A point source far away is mono; downmixing before the delay also halves the line of stereo loops.
    const mono = new GainNode(ctx, { gain: 1, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    const delay = new DelayNode(ctx, { maxDelayTime: maxDelay, delayTime: 0 });
    this.delaySeconds = maxDelay;
    const airGain = new GainNode(ctx, { gain: 0 });
    const lp1 = lowpass(ctx, 20000);
    const lp2 = lowpass(ctx, 20000);
    const panner = new PannerNode(ctx, { panningModel: 'equalpower', distanceModel: 'linear', refDistance: 1, maxDistance: 10000, rolloffFactor: 0, positionX: 0, positionY: 0, positionZ: -1 });
    this.input.connect(mono).connect(delay).connect(airGain).connect(lp1).connect(lp2).connect(panner).connect(bus.air);
    const blp1 = lowpass(ctx, 200);
    const blp2 = lowpass(ctx, 200);
    const bodyGain = new GainNode(ctx, { gain: 0 });
    let tail: AudioNode = this.input.connect(blp1).connect(blp2);
    const extra: AudioNode[] = [];
    if (resonance) {
      const peak = new BiquadFilterNode(ctx, { type: 'peaking', frequency: resonance.hz, Q: 2.5, gain: resonance.db });
      tail = tail.connect(peak);
      extra.push(peak);
    }
    tail.connect(bodyGain).connect(bus.body);
    this.airGain = new Smooth(airGain.gain, 0);
    this.airLp1 = new Smooth(lp1.frequency, lp1.frequency.value);
    this.airLp2 = new Smooth(lp2.frequency, lp2.frequency.value);
    this.px = new Smooth(panner.positionX, 0);
    this.py = new Smooth(panner.positionY, 0);
    this.pz = new Smooth(panner.positionZ, -1);
    this.delayParam = new Smooth(delay.delayTime, 0);
    this.bodyGain = new Smooth(bodyGain.gain, 0);
    this.bodyLp1 = new Smooth(blp1.frequency, blp1.frequency.value);
    this.bodyLp2 = new Smooth(blp2.frequency, blp2.frequency.value);
    this.nodes = [this.input, mono, delay, airGain, lp1, lp2, panner, blp1, blp2, bodyGain, ...extra];
  }

  get nodeCount(): number {
    return this.nodes.length;
  }

  apply(p: SourcePaths, time: number, sm: Smoothing): void {
    const nyq = this.ctx.sampleRate * NYQUIST_MARGIN;
    if (this.first) {
      this.first = false;
      this.delayParam.jump(p.air.delay, time);
      this.airGain.set(p.air.gain, time, sm.gain);
    } else if (this.pendingJumpAt !== null) {
      // Camera cut in progress: once the airborne path is silent, move the delay line and fade back in.
      if (time >= this.pendingJumpAt) {
        this.pendingJumpAt = null;
        this.delayParam.jump(p.air.delay, time);
        this.airGain.rampFromHold(p.air.gain, time, 2 * JUMP_DUCK);
      }
    } else if (p.air.jump) {
      // Camera cut: duck instead of sweeping the delay line (which would be a huge Doppler glide).
      this.airGain.ramp(0, time, JUMP_DUCK);
      this.pendingJumpAt = time + JUMP_DUCK;
    } else {
      this.delayParam.set(p.air.delay, time, sm.delay);
      this.airGain.set(p.air.gain, time, sm.gain);
    }
    this.lastDelay = p.air.delay;
    const fc = Math.min(nyq, p.air.cutoff);
    this.airLp1.set(fc, time, sm.filter);
    this.airLp2.set(fc, time, sm.filter);
    this.px.set(p.air.pan.x, time, sm.position);
    this.py.set(p.air.pan.y, time, sm.position);
    this.pz.set(p.air.pan.z, time, sm.position);
    this.bodyGain.set(p.body.gain, time, sm.gain);
    const bc = Math.min(nyq, p.body.cutoff);
    this.bodyLp1.set(bc, time, sm.filter);
    this.bodyLp2.set(bc, time, sm.filter);
  }

  get audible(): boolean {
    return this.airGain.target > 0 || this.bodyGain.target > 0;
  }

  dispose(): void {
    for (const n of this.nodes) n.disconnect();
  }
}

/** Seconds a released engine voice is kept beyond its propagation delay (smoothing ramps, filter tails). */
const DRAIN_MARGIN = 1.5;

/** Deterministic start offset inside a loop so voices sharing an asset are never phase-aligned. */
const loopOffset = (buffer: AudioBuffer, seed: number): number => (((seed >>> 0) % 9973) / 9973) * buffer.duration;

function loopSource(ctx: BaseAudioContext, buffer: AudioBuffer, seed: number, time: number): AudioBufferSourceNode {
  const src = new AudioBufferSourceNode(ctx, { buffer, loop: true });
  src.start(time, loopOffset(buffer, seed));
  return src;
}

/** A layer: gain with optional slow amplitude modulation g * (1 + depth * slow). */
class ModGain {
  readonly node: GainNode;
  private readonly g: Smooth;
  private readonly depthNode: GainNode | null;
  private readonly depth: Smooth | null;
  constructor(
    ctx: BaseAudioContext,
    slow: AudioNode | null,
    private readonly modDepth: number,
  ) {
    this.node = new GainNode(ctx, { gain: 0 });
    this.g = new Smooth(this.node.gain, 0);
    if (slow && modDepth > 0) {
      this.depthNode = new GainNode(ctx, { gain: 0 });
      slow.connect(this.depthNode);
      this.depthNode.connect(this.node.gain);
      this.depth = new Smooth(this.depthNode.gain, 0);
    } else {
      this.depthNode = null;
      this.depth = null;
    }
  }
  set(gain: number, time: number, tc: number): void {
    this.g.set(gain, time, tc);
    this.depth?.set(gain * this.modDepth, time, tc);
  }
  get target(): number {
    return this.g.target;
  }
  get nodeCount(): number {
    return this.depthNode ? 2 : 1;
  }
  dispose(): void {
    this.node.disconnect();
    this.depthNode?.disconnect();
  }
}

/** Crackle of variable density: equal-power crossfade of the noise bank's crackle levels, high-passed. */
class CrackleLayer {
  readonly out: GainNode;
  private readonly gain: Smooth;
  private readonly weights: Smooth[];
  private readonly nodes: AudioNode[] = [];
  constructor(ctx: BaseAudioContext, noise: NoiseBank, seed: number, time: number, highpassHz: number) {
    const hp = highpass(ctx, highpassHz);
    this.out = new GainNode(ctx, { gain: 0 });
    this.gain = new Smooth(this.out.gain, 0);
    this.weights = CRACKLE_LEVELS.map((rate, i) => {
      const src = noiseSource(ctx, noise, `crackle-${rate}`, seed + 977 * i, time);
      const g = new GainNode(ctx, { gain: 0 });
      src.connect(g).connect(hp);
      this.nodes.push(src, g);
      return new Smooth(g.gain, 0);
    });
    hp.connect(this.out);
    this.nodes.push(hp);
  }
  set(gain: number, rate: number, time: number, sm: Smoothing): void {
    this.gain.set(gain, time, sm.gain);
    const w = crackleWeights(rate);
    this.weights.forEach((s, i) => s.set(w[i]!, time, sm.filter));
  }
  get target(): number {
    return this.gain.target;
  }
  get nodeCount(): number {
    return this.nodes.length + 1;
  }
  dispose(): void {
    for (const n of this.nodes) {
      if (n instanceof AudioBufferSourceNode) n.stop();
      n.disconnect();
    }
    this.out.disconnect();
  }
}

class EngineVoice {
  readonly path: PathOut;
  private readonly sum: GainNode;
  private readonly coreSrc: AudioBufferSourceNode;
  private readonly coreRate: Smooth;
  private readonly coreLp: Smooth;
  private readonly core: ModGain;
  private readonly rumble: ModGain | null;
  private readonly rumbleLp1: Smooth | null;
  private readonly rumbleLp2: Smooth | null;
  private readonly hiss: ModGain | null;
  private readonly crackle: CrackleLayer | null;
  private readonly sources: AudioBufferSourceNode[] = [];
  private readonly nodes: AudioNode[] = [];
  private readonly transients = new Set<AudioBufferSourceNode>();
  running = 0;
  releasedAt: number | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly bank: AssetBank,
    noise: NoiseBank,
    readonly target0: EngineVoiceTarget,
    private readonly config: AudioConfig,
    bus: BusNodes,
    time: number,
  ) {
    const p = config.engines.profiles[target0.profileId]!;
    const seed = target0.seed;
    this.sum = new GainNode(ctx, { gain: 1 });
    this.path = new PathOut(ctx, bus, config.mix.propagation.maxDelay, { hz: p.body.resonanceHz, db: p.body.resonanceDb });
    this.sum.connect(this.path.input);
    const mod = slowModulator(ctx, noise, seed, time, p.rumble?.turbulenceHz ?? 4);
    const slow = mod.output;
    this.sources.push(...mod.sources);
    this.nodes.push(slow);

    const coreBuf = bank.buffers.get(p.core.asset)!;
    this.coreSrc = loopSource(ctx, coreBuf, seed, time);
    const coreLp = lowpass(ctx, p.core.cutoffHz[1]);
    this.core = new ModGain(ctx, slow, p.core.turbulence);
    this.coreSrc.connect(coreLp).connect(this.core.node).connect(this.sum);
    this.coreRate = new Smooth(this.coreSrc.playbackRate, p.core.rate[0]);
    this.coreLp = new Smooth(coreLp.frequency, coreLp.frequency.value);
    this.sources.push(this.coreSrc);
    this.nodes.push(this.sum, coreLp);

    if (p.rumble) {
      const src = noiseSource(ctx, noise, 'brown', seed + 1, time);
      const l1 = lowpass(ctx, p.rumble.cutoffHz);
      const l2 = lowpass(ctx, p.rumble.cutoffHz);
      this.rumble = new ModGain(ctx, slow, p.rumble.turbulence);
      src.connect(l1).connect(l2).connect(this.rumble.node).connect(this.sum);
      this.rumbleLp1 = new Smooth(l1.frequency, l1.frequency.value);
      this.rumbleLp2 = new Smooth(l2.frequency, l2.frequency.value);
      this.sources.push(src);
      this.nodes.push(l1, l2);
    } else {
      this.rumble = null;
      this.rumbleLp1 = null;
      this.rumbleLp2 = null;
    }
    if (p.hiss) {
      const src = noiseSource(ctx, noise, 'pink', seed + 2, time);
      const hp = highpass(ctx, p.hiss.highpassHz);
      const lp = lowpass(ctx, p.hiss.lowpassHz);
      this.hiss = new ModGain(ctx, slow, p.core.turbulence);
      src.connect(hp).connect(lp).connect(this.hiss.node).connect(this.sum);
      this.sources.push(src);
      this.nodes.push(hp, lp);
    } else this.hiss = null;
    if (p.crackle) {
      this.crackle = new CrackleLayer(ctx, noise, seed + 3, time, p.crackle.highpassHz);
      this.crackle.out.connect(this.sum);
    } else this.crackle = null;
  }

  apply(t: EngineVoiceTarget, time: number, sm: Smoothing): void {
    const p = this.config.engines.profiles[t.profileId]!;
    this.running = t.running;
    this.core.set(t.core.gain, time, sm.gain);
    this.coreRate.set(t.core.rate, time, sm.filter);
    this.coreLp.set(Math.min(t.core.cutoff, this.ctx.sampleRate * NYQUIST_MARGIN), time, sm.filter);
    this.rumble?.set(t.rumble.gain, time, sm.gain);
    this.rumbleLp1?.set(t.rumble.cutoff, time, sm.filter);
    this.rumbleLp2?.set(t.rumble.cutoff, time, sm.filter);
    this.hiss?.set(t.hiss.gain, time, sm.gain);
    this.crackle?.set(t.crackle.gain, t.crackle.rate, time, sm);
    if (t.ignition && p.ignition) this.transient(p.ignition.asset, t.ignition.gain, t.ignition.offset, time);
    if (t.shutdown && p.shutdown) this.transient(p.shutdown.asset, t.shutdown.gain, t.shutdown.offset, time);
    this.path.apply(t.paths, time, sm);
  }

  private transient(asset: string, gain: number, offset: number, time: number): void {
    const buffer = this.bank.buffers.get(asset)!;
    if (offset >= buffer.duration) return;
    const src = new AudioBufferSourceNode(this.ctx, { buffer });
    const g = new GainNode(this.ctx, { gain });
    src.connect(g).connect(this.sum);
    this.transients.add(src);
    src.onended = () => {
      g.disconnect();
      src.disconnect();
      this.transients.delete(src);
    };
    src.start(time, offset);
  }

  release(time: number, sm: Smoothing): void {
    if (this.releasedAt !== null) return;
    this.releasedAt = time;
    this.core.set(0, time, sm.gain);
    this.rumble?.set(0, time, sm.gain);
    this.hiss?.set(0, time, sm.gain);
    this.crackle?.set(0, 0, time, sm);
    this.running = 0;
  }

  /** The cluster sounds again while this voice is still draining: keep it (its delay line holds the tail). */
  revive(): void {
    this.releasedAt = null;
  }

  /** Released and everything (the propagation delay line, the layers' ramps, transients) has drained. */
  finished(now: number): boolean {
    return this.releasedAt !== null && now > this.releasedAt + this.path.lastDelay + DRAIN_MARGIN && this.transients.size === 0;
  }

  get playingTransients(): number {
    return this.transients.size;
  }

  get nodeCount(): number {
    return (
      this.sources.length +
      this.nodes.length +
      this.core.nodeCount +
      (this.rumble?.nodeCount ?? 0) +
      (this.hiss?.nodeCount ?? 0) +
      (this.crackle?.nodeCount ?? 0) +
      this.path.nodeCount +
      2 * this.transients.size
    );
  }

  dispose(): void {
    for (const s of this.sources) s.stop();
    for (const s of this.transients) s.stop();
    for (const n of [...this.sources, ...this.nodes]) n.disconnect();
    this.core.dispose();
    this.rumble?.dispose();
    this.hiss?.dispose();
    this.crackle?.dispose();
    this.path.dispose();
  }
}

class AeroVoice {
  readonly path: PathOut;
  private readonly wind: Smooth;
  private readonly windLp: Smooth;
  private readonly noise: Smooth;
  private readonly noiseHp: Smooth;
  private readonly noiseLp: Smooth;
  private readonly buffet: ModGain;

  constructor(ctx: BaseAudioContext, bank: AssetBank, noise: NoiseBank, config: AudioConfig, bus: BusNodes, time: number) {
    const a = config.environment.aero;
    const seed = 0xae70;
    const sum = new GainNode(ctx);
    this.path = new PathOut(ctx, bus, config.mix.propagation.maxDelay, null);
    sum.connect(this.path.input);
    const slow = slowModulator(ctx, noise, seed, time, a.buffet.turbulenceHz).output;
    const windSrc = loopSource(ctx, bank.buffers.get(a.wind.asset)!, seed, time);
    const windLp = lowpass(ctx, a.wind.cutoffHz[1]);
    const windGain = new GainNode(ctx, { gain: 0 });
    windSrc.connect(windLp).connect(windGain).connect(sum);
    this.wind = new Smooth(windGain.gain, 0);
    this.windLp = new Smooth(windLp.frequency, windLp.frequency.value);
    const pink = noiseSource(ctx, noise, 'pink', seed + 1, time);
    const hp = highpass(ctx, a.noise.bandHz[0]);
    const lp = lowpass(ctx, a.noise.bandHz[1]);
    const noiseGain = new GainNode(ctx, { gain: 0 });
    pink.connect(hp).connect(lp).connect(noiseGain).connect(sum);
    this.noise = new Smooth(noiseGain.gain, 0);
    this.noiseHp = new Smooth(hp.frequency, hp.frequency.value);
    this.noiseLp = new Smooth(lp.frequency, lp.frequency.value);
    const brown = noiseSource(ctx, noise, 'brown', seed + 2, time);
    const blp1 = lowpass(ctx, a.buffet.cutoffHz);
    const blp2 = lowpass(ctx, a.buffet.cutoffHz);
    this.buffet = new ModGain(ctx, slow, a.buffet.turbulence);
    brown.connect(blp1).connect(blp2).connect(this.buffet.node).connect(sum);
    // sum, slow (2 sources + mix), wind (3), pink band (4), brown buffet (3) + the path and the modulated gain
    this.nodeCount = 1 + 3 + 3 + 4 + 3 + this.path.nodeCount + this.buffet.nodeCount;
  }

  readonly nodeCount: number;

  apply(t: AeroTarget, time: number, sm: Smoothing): void {
    this.wind.set(t.wind.gain, time, sm.gain);
    this.windLp.set(t.wind.cutoff, time, sm.filter);
    this.noise.set(t.noise.gain, time, sm.gain);
    this.noiseHp.set(t.noise.lowHz, time, sm.filter);
    this.noiseLp.set(t.noise.highHz, time, sm.filter);
    this.buffet.set(t.buffet.gain, time, sm.gain);
    this.path.apply(t.paths, time, sm);
  }

  get audible(): boolean {
    return this.path.audible && (this.wind.target > 0 || this.noise.target > 0 || this.buffet.target > 0);
  }
}

class ReentryVoice {
  readonly path: PathOut;
  private readonly roar: Smooth;
  private readonly hiss: Smooth;
  private readonly crackle: CrackleLayer;
  private readonly rumble: ModGain;

  constructor(ctx: BaseAudioContext, bank: AssetBank, noise: NoiseBank, config: AudioConfig, bus: BusNodes, time: number) {
    const r = config.environment.reentry;
    const seed = 0x5e1a;
    const sum = new GainNode(ctx);
    this.path = new PathOut(ctx, bus, config.mix.propagation.maxDelay, null);
    sum.connect(this.path.input);
    const slow = slowModulator(ctx, noise, seed, time, r.rumble.turbulenceHz).output;
    const roarSrc = loopSource(ctx, bank.buffers.get(r.roar.asset)!, seed, time);
    const roarGain = new GainNode(ctx, { gain: 0 });
    roarSrc.connect(roarGain).connect(sum);
    this.roar = new Smooth(roarGain.gain, 0);
    const pink = noiseSource(ctx, noise, 'pink', seed + 1, time);
    const hp = highpass(ctx, r.hiss.highpassHz);
    const lp = lowpass(ctx, r.hiss.lowpassHz);
    const hissGain = new GainNode(ctx, { gain: 0 });
    pink.connect(hp).connect(lp).connect(hissGain).connect(sum);
    this.hiss = new Smooth(hissGain.gain, 0);
    this.crackle = new CrackleLayer(ctx, noise, seed + 2, time, r.crackle.highpassHz);
    this.crackle.out.connect(sum);
    const brown = noiseSource(ctx, noise, 'brown', seed + 3, time);
    const l1 = lowpass(ctx, r.rumble.cutoffHz);
    const l2 = lowpass(ctx, r.rumble.cutoffHz);
    this.rumble = new ModGain(ctx, slow, r.rumble.turbulence);
    brown.connect(l1).connect(l2).connect(this.rumble.node).connect(sum);
    // sum, slow (3), roar (2), hiss band (4), brown rumble (3) + path, crackle and the modulated gain
    this.nodeCount = 1 + 3 + 2 + 4 + 3 + this.path.nodeCount + this.crackle.nodeCount + this.rumble.nodeCount;
  }

  readonly nodeCount: number;

  apply(t: ReentryTarget, time: number, sm: Smoothing): void {
    this.roar.set(t.roar.gain, time, sm.gain);
    this.hiss.set(t.hiss.gain, time, sm.gain);
    this.crackle.set(t.crackle.gain, t.crackle.rate, time, sm);
    this.rumble.set(t.rumble.gain, time, sm.gain);
    this.path.apply(t.paths, time, sm);
  }

  get audible(): boolean {
    return this.path.audible && (this.roar.target > 0 || this.hiss.target > 0 || this.rumble.target > 0 || this.crackle.target > 0);
  }
}

class CabinVoice {
  private readonly ambience: Smooth;
  private readonly airflow: Smooth;
  private readonly hum: Smooth;

  constructor(ctx: BaseAudioContext, bank: AssetBank, noise: NoiseBank, config: AudioConfig, bus: BusNodes, time: number) {
    const c = config.environment.cabin;
    const seed = 0xcab1;
    const src = loopSource(ctx, bank.buffers.get(c.ambience.asset)!, seed, time);
    const g = new GainNode(ctx, { gain: 0 });
    src.connect(g).connect(bus.direct);
    this.ambience = new Smooth(g.gain, 0);
    const pink = noiseSource(ctx, noise, 'pink', seed + 1, time);
    const hp = highpass(ctx, c.airflow.bandHz[0]);
    const lp = lowpass(ctx, c.airflow.bandHz[1]);
    const ag = new GainNode(ctx, { gain: 0 });
    pink.connect(hp).connect(lp).connect(ag).connect(bus.direct);
    this.airflow = new Smooth(ag.gain, 0);
    const hg = new GainNode(ctx, { gain: 0 });
    let oscillators = 0;
    c.hum.harmonics.forEach((amp, i) => {
      const f = c.hum.freqHz * (i + 1);
      if (f >= ctx.sampleRate * NYQUIST_MARGIN || amp === 0) return;
      const osc = new OscillatorNode(ctx, { type: 'sine', frequency: f });
      const og = new GainNode(ctx, { gain: amp });
      osc.connect(og).connect(hg);
      osc.start(time);
      oscillators++;
    });
    hg.connect(bus.direct);
    this.hum = new Smooth(hg.gain, 0);
    this.nodeCount = 2 + 4 + 1 + 2 * oscillators;
  }

  readonly nodeCount: number;

  apply(t: CabinTarget, time: number, tc: number): void {
    this.ambience.set(t.ambience, time, tc);
    this.airflow.set(t.airflow, time, tc);
    this.hum.set(t.hum, time, tc);
  }

  get audible(): boolean {
    return this.ambience.target > 0;
  }
}

/** Surface ambience beds: one looping source per ambience asset, mixed, low-passed, into the aero bus. */
class AmbienceVoice {
  private readonly gains = new Map<string, Smooth>();
  private readonly lp: Smooth;
  readonly nodeCount: number;

  constructor(
    private readonly ctx: BaseAudioContext,
    bank: AssetBank,
    config: AudioConfig,
    bus: BusNodes,
    time: number,
  ) {
    const lp = lowpass(ctx, 18000);
    lp.connect(bus.direct);
    this.lp = new Smooth(lp.frequency, lp.frequency.value);
    const ids = ambienceAssetIds(config);
    ids.forEach((id, i) => {
      const src = loopSource(ctx, bank.buffers.get(id)!, 0xa3b1 + 131 * i, time);
      const g = new GainNode(ctx, { gain: 0 });
      src.connect(g).connect(lp);
      this.gains.set(id, new Smooth(g.gain, 0));
    });
    this.nodeCount = 1 + 2 * ids.length;
  }

  apply(t: AmbienceTarget, time: number, sm: Smoothing): void {
    for (const [id, s] of this.gains) s.set(t.gains[id] ?? 0, time, sm.listenerKind);
    this.lp.set(Math.min(t.cutoff, this.ctx.sampleRate * NYQUIST_MARGIN), time, sm.filter);
  }

  get audible(): boolean {
    for (const s of this.gains.values()) if (s.target > 0) return true;
    return false;
  }
}

/** Procedural master-alarm tone: the configured tone sequence as one loopable buffer. */
export function renderAlarmBuffer(ctx: BaseAudioContext, ui: AudioConfig['ui']): AudioBuffer {
  const a = ui.alarm;
  const sr = ctx.sampleRate;
  const segs = a.tones.map((t) => ({ f: t.freqHz, n: Math.round(t.duration * sr), gap: Math.round(a.gap * sr) }));
  const total = segs.reduce((s, x) => s + x.n + x.gap, 0);
  const buf = ctx.createBuffer(1, total, sr);
  const d = buf.getChannelData(0);
  let i = 0;
  const ramp = Math.round(0.004 * sr);
  const lpC = Math.exp((-2 * Math.PI * a.lowpassHz) / sr);
  let lp = 0;
  for (const s of segs) {
    let phase = 0;
    for (let k = 0; k < s.n; k++) {
      phase += s.f / sr;
      // Odd-harmonic (square-like) timbre, band-limited by construction, then a gentle one-pole low-pass.
      const p = 2 * Math.PI * phase;
      const x = Math.sin(p) + Math.sin(3 * p) / 3 + Math.sin(5 * p) / 5 + Math.sin(7 * p) / 7;
      const env = Math.min(1, k / ramp, (s.n - k) / ramp);
      lp = lpC * lp + (1 - lpC) * x;
      d[i++] = 0.5 * env * lp;
    }
    for (let k = 0; k < s.gap; k++) d[i++] = 0;
  }
  return buf;
}

export interface AudioGraphOptions {
  /** Called once per problem reported by the model (unknown part definitions...). */
  onProblem?: (message: string) => void;
  /** Context time at which the continuous sources start (offline renders pass 0). */
  startTime?: number;
}

/** What the graph holds right now (resource load, not just what is audible). */
export interface AudioGraphStats {
  /** Engine voices allocated: sounding, or released and draining their delay line and transients. */
  engineVoices: number;
  /** Audio nodes held: the static mix (buses, master, environment voices) + engine voices + one-shots. */
  nodes: number;
  /** Delay lines allocated, and their total length (each one mono): memory = seconds x sampleRate x 4 B. */
  delayLines: number;
  delayLineSeconds: number;
  /** One-shot sources playing (events, creaks, clicks, engine transients). */
  oneShots: number;
}

export interface AudioGraph {
  readonly ctx: BaseAudioContext;
  /** Final output (connect to ctx.destination or an analyser). */
  readonly output: AudioNode;
  /** The master just before the soft ceiling (after compressor and limiter), in output units. */
  readonly preCeiling: AudioNode;
  /** Input of the master section (where the buses sum): tests feed calibration signals here. */
  readonly masterInput: AudioNode;
  /** Measurement points: bus outputs, their path sub-mixes, and the master output. */
  readonly taps: Record<TapName, AudioNode>;
  apply(out: ModelOutput, time: number): void;
  setMasterVolume(volume: number, time: number): void;
  /** Voices using resources: allocated engine voices (also while draining), one-shots, transients, audible environment voices, alarm. */
  activeVoices(): number;
  stats(): AudioGraphStats;
  dispose(): void;
}

/** Build the whole graph in `ctx`; sources start at `startTime` (default ctx.currentTime). */
export function createAudioGraph(ctx: BaseAudioContext, bank: AssetBank, config: AudioConfig, opts: AudioGraphOptions = {}): AudioGraph {
  const t0 = opts.startTime ?? ctx.currentTime;
  const noise = noiseBank(ctx);
  const mix = config.mix;
  const sm = mix.smoothing;
  const missing = [...new Set(Object.keys(config.assets))].filter((id) => !bank.buffers.has(id));
  if (missing.length > 0) throw new Error(`audio graph: assets not decoded: ${missing.join(', ')}`);

  const masterSum = new GainNode(ctx, { gain: dbToGain(mix.master.gainDb) });
  const buses = {} as Record<BusId, BusNodes>;
  for (const id of BUS_NAMES) {
    const air = new GainNode(ctx);
    const body = new GainNode(ctx);
    const direct = new GainNode(ctx);
    const sum = new GainNode(ctx, { gain: dbToGain(mix.buses[id].gainDb) });
    const fade = new GainNode(ctx, { gain: 1 });
    const out = new GainNode(ctx);
    air.connect(sum);
    body.connect(sum);
    direct.connect(sum);
    sum.connect(fade).connect(out).connect(masterSum);
    buses[id] = { air, body, direct, sum, sumParam: new Smooth(sum.gain, sum.gain.value), fade, fadeParam: new Smooth(fade.gain, 1), out };
  }

  const volume = new GainNode(ctx, { gain: 1 });
  const volumeParam = new Smooth(volume.gain, 1);
  const pause = new GainNode(ctx, { gain: 1 });
  const pauseParam = new Smooth(pause.gain, 1);
  const c = mix.master.compressor;
  const comp = new DynamicsCompressorNode(ctx, { threshold: c.thresholdDb, knee: c.kneeDb, ratio: c.ratio, attack: c.attack, release: c.release });
  // Both dynamics nodes add an automatic makeup gain; it is cancelled exactly, so the configured makeup is the only one.
  const makeup = new GainNode(ctx, { gain: dbToGain(c.makeupDb - compressorMakeupDb(c.thresholdDb, c.kneeDb, c.ratio)) });
  const l = mix.master.limiter;
  const limiter = new DynamicsCompressorNode(ctx, { threshold: l.thresholdDb, knee: l.kneeDb, ratio: l.ratio, attack: l.attack, release: l.release });
  const limiterMakeup = new GainNode(ctx, { gain: dbToGain(-compressorMakeupDb(l.thresholdDb, l.kneeDb, l.ratio)) });
  const pre = new GainNode(ctx, { gain: 1 / mix.master.headroom });
  const shaper = new WaveShaperNode(ctx, { curve: ceilingCurve(mix.master), oversample: 'none' });
  masterSum.connect(volume).connect(pause).connect(comp).connect(makeup).connect(limiter).connect(limiterMakeup).connect(pre).connect(shaper);
  // buses: 7 nodes each (+ fade param); master: sum, volume, pause, compressor, makeup, limiter, makeup, pre, shaper
  const staticNodes = 7 * BUS_NAMES.length + 9;

  const taps = { master: shaper } as unknown as Record<TapName, AudioNode>;
  for (const id of BUS_NAMES) {
    taps[id] = buses[id].out;
    taps[`${id}.air`] = buses[id].air;
    taps[`${id}.body`] = buses[id].body;
    taps[`${id}.direct`] = buses[id].direct;
  }

  const engines = new Map<string, EngineVoice>();
  const aero = new AeroVoice(ctx, bank, noise, config, buses.aero, t0);
  const reentry = new ReentryVoice(ctx, bank, noise, config, buses.reentry, t0);
  const cabin = new CabinVoice(ctx, bank, noise, config, buses.cabin, t0);
  const ambience = new AmbienceVoice(ctx, bank, config, buses.aero, t0);
  /** Playing one-shot sources and the number of nodes each holds. */
  const oneShots = new Map<AudioBufferSourceNode, number>();
  const alarmBuffer = renderAlarmBuffer(ctx, config.ui);
  let alarm: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  /** The first frame sets the listener-kind bus gains at once (no glide from the outside mix). */
  let firstApply = true;

  const startOneShot = (r: OneShotRequest, time: number): void => {
    const buffer = bank.buffers.get(r.asset);
    if (!buffer) throw new Error(`audio: one-shot asset "${r.asset}" is not decoded`);
    const bus = buses[r.bus];
    const play = (dest: AudioNode, at: number, chain: AudioNode[]): void => {
      const src = new AudioBufferSourceNode(ctx, { buffer, playbackRate: r.rate });
      let node: AudioNode = src;
      for (const n of chain) node = node.connect(n);
      node.connect(dest);
      oneShots.set(src, 1 + chain.length);
      src.onended = () => {
        src.disconnect();
        for (const n of chain) n.disconnect();
        oneShots.delete(src);
      };
      src.start(at);
    };
    if (r.direct) {
      play(bus.direct, time, [new GainNode(ctx, { gain: r.gain })]);
      return;
    }
    const nyq = ctx.sampleRate * NYQUIST_MARGIN;
    if (r.air) {
      const panner = new PannerNode(ctx, {
        panningModel: 'equalpower',
        distanceModel: 'linear',
        rolloffFactor: 0,
        positionX: r.air.pan.x,
        positionY: r.air.pan.y,
        positionZ: r.air.pan.z,
      });
      const fc = Math.min(nyq, r.air.cutoff);
      play(bus.air, time + r.air.delay, [new GainNode(ctx, { gain: r.gain * r.air.gain }), lowpass(ctx, fc), lowpass(ctx, fc), panner]);
    }
    if (r.body) {
      const fc = Math.min(nyq, r.body.cutoff);
      play(bus.body, time, [lowpass(ctx, fc), lowpass(ctx, fc), new GainNode(ctx, { gain: r.gain * r.body.gain })]);
    }
  };

  const graph: AudioGraph = {
    ctx,
    output: shaper,
    preCeiling: limiterMakeup,
    masterInput: masterSum,
    taps,
    apply(out, time) {
      for (const p of out.problems) opts.onProblem?.(p);
      for (const id of BUS_NAMES) {
        const b = mix.buses[id];
        const g = dbToGain(out.interior ? b.interiorGainDb : b.gainDb);
        if (firstApply) buses[id].sumParam.jump(g, time);
        else buses[id].sumParam.set(g, time, sm.listenerKind);
        if (b.fadeAboveWarp) buses[id].fadeParam.ramp(out.continuous, time, mix.warp.fadeTime);
      }
      pauseParam.ramp(out.paused ? 0 : 1, time, mix.pause.fadeTime);
      const live = new Set<string>();
      for (const t of out.engines) {
        live.add(t.key);
        let v = engines.get(t.key);
        if (!v) {
          v = new EngineVoice(ctx, bank, noise, t, config, buses.engines, time);
          engines.set(t.key, v);
        } else if (v.releasedAt !== null) v.revive();
        v.apply(t, time, sm);
      }
      for (const [k, v] of engines) {
        if (live.has(k)) continue;
        v.release(time, sm);
        if (v.finished(time)) {
          v.dispose();
          engines.delete(k);
        }
      }
      firstApply = false;
      aero.apply(out.aero, time, sm);
      reentry.apply(out.reentry, time, sm);
      ambience.apply(out.ambience, time, sm);
      cabin.apply(out.cabin, time, sm.listenerKind);
      for (const r of out.oneShots) startOneShot(r, time);
      if (out.alarm && !alarm) {
        const src = new AudioBufferSourceNode(ctx, { buffer: alarmBuffer, loop: true });
        const gain = new GainNode(ctx, { gain: dbToGain(config.ui.alarm.gainDb) });
        src.connect(gain).connect(buses.ui.direct);
        src.start(time);
        alarm = { src, gain };
      } else if (!out.alarm && alarm) {
        const a = alarm;
        a.gain.gain.cancelAndHoldAtTime(time);
        a.gain.gain.linearRampToValueAtTime(0, time + 0.03);
        a.src.stop(time + 0.04);
        a.src.onended = () => {
          a.src.disconnect();
          a.gain.disconnect();
        };
        alarm = null;
      }
    },
    setMasterVolume(v, time) {
      volumeParam.set(Math.max(0, v), time, sm.volume);
    },
    activeVoices() {
      let n = oneShots.size + (alarm ? 1 : 0);
      for (const v of engines.values()) n += 1 + v.playingTransients;
      if (aero.audible) n++;
      if (reentry.audible) n++;
      if (ambience.audible) n++;
      if (cabin.audible) n++;
      return n;
    },
    stats() {
      let nodes = staticNodes + aero.nodeCount + reentry.nodeCount + cabin.nodeCount + ambience.nodeCount + (alarm ? 2 : 0);
      let delayLines = 2;
      let delayLineSeconds = aero.path.delaySeconds + reentry.path.delaySeconds;
      let transients = 0;
      for (const v of engines.values()) {
        nodes += v.nodeCount;
        delayLines++;
        delayLineSeconds += v.path.delaySeconds;
        transients += v.playingTransients;
      }
      for (const k of oneShots.values()) nodes += k;
      return { engineVoices: engines.size, nodes, delayLines, delayLineSeconds, oneShots: oneShots.size + transients };
    },
    dispose() {
      for (const v of engines.values()) v.dispose();
      engines.clear();
      for (const s of oneShots.keys()) s.stop();
      alarm?.src.stop();
      masterSum.disconnect();
      shaper.disconnect();
    },
  };
  return graph;
}

/**
 * Soft ceiling: exactly linear below `linearUntil`, then a tanh knee that approaches `ceiling`; inputs up
 * to `headroom` are shaped, anything beyond is held at the curve's end (still below the ceiling). The node
 * runs without oversampling so no reconstruction filter can overshoot the ceiling.
 */
export function ceilingCurve(m: MixConfig['master']): Float32Array<ArrayBuffer> {
  const n = 8193;
  const curve = new Float32Array(n);
  const L = m.linearUntil;
  const C = m.ceiling;
  for (let i = 0; i < n; i++) {
    const u = (2 * i) / (n - 1) - 1;
    const x = u * m.headroom;
    const a = Math.abs(x);
    const y = a <= L ? a : L + (C - L) * Math.tanh((a - L) / (C - L));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}
