/**
 * PerfRecorder: pooled GPU timestamp queries at pass boundaries, CPU zones, counters, and the
 * window.__perf snapshot with a per-feature breakdown.
 *
 * Pass naming: `<featureId>.<pass>` for passes a feature owns, `core.<pass>` for core passes. Core-owned
 * passes that host feature hooks (shadow, gbuffer, water, background, transparent, overlay) are split
 * between the participating features: in attribution mode each feature's hook runs in its own pass named
 * `<featureId>.<hook>` and is measured exactly; in normal mode the pass time is divided by the shares
 * measured in the most recent attribution frames (equal shares until one has run).
 *
 * Work encoded BETWEEN passes (the core's texture copies) has no timestamp of its own. `gpuGap(name)`
 * marks such work: its time is the gap from the end timestamp of the pass encoded before it to the
 * begin timestamp of the pass encoded after it, reported as pass `name` and included in the GPU total.
 */
import type { PerfRecorder, PerfSnapshot } from '@/core/contracts/render';

const MAX_QUERIES = 512;
const WINDOW = 300;

class Ring {
  private readonly data: Float64Array;
  private n = 0;
  private i = 0;
  constructor(size = WINDOW) {
    this.data = new Float64Array(size);
  }
  push(v: number): void {
    this.data[this.i] = v;
    this.i = (this.i + 1) % this.data.length;
    if (this.n < this.data.length) this.n++;
  }
  get count(): number {
    return this.n;
  }
  clear(): void {
    this.n = 0;
    this.i = 0;
  }
  sorted(): Float64Array {
    return this.data.slice(0, this.n).sort();
  }
  percentile(p: number): number {
    if (this.n === 0) return 0;
    const s = this.sorted();
    return s[Math.min(this.n - 1, Math.floor(p * this.n))]!;
  }
  max(): number {
    let m = 0;
    for (let k = 0; k < this.n; k++) m = Math.max(m, this.data[k]!);
    return m;
  }
  mean(): number {
    let s = 0;
    for (let k = 0; k < this.n; k++) s += this.data[k]!;
    return this.n ? s / this.n : 0;
  }
}

interface Gap {
  name: string;
  /** Index (into the frame's pass names) of the last pass begun before the marked work. */
  prev: number;
}

interface PendingFrame {
  names: string[];
  gaps: Gap[];
  buffer: GPUBuffer;
  /** Hook pass -> feature ids that took part (normal mode). */
  hookFeatures: Map<string, { ids: string[]; core: boolean }>;
  cpu: Map<string, number>;
}

export class Perf implements PerfRecorder {
  private readonly querySet: GPUQuerySet | null;
  private readonly resolveBuffer: GPUBuffer | null;
  private readonly freeBuffers: GPUBuffer[] = [];
  private names: string[] = [];
  private gaps: Gap[] = [];
  private hookFeatures = new Map<string, { ids: string[]; core: boolean }>();
  private readonly passRings = new Map<string, Ring>();
  private cpuOpen = new Map<string, number>();
  private cpuFrame = new Map<string, number>();
  private readonly counters: Record<string, number> = {};
  private readonly raf = new Ring();
  private readonly cpu = new Ring();
  private readonly gpu = new Ring();
  private readonly featureGpu = new Map<string, Ring>();
  private readonly featureCpu = new Map<string, Ring>();
  private latestPasses: Record<string, { gpuMs: number; cpuMs: number }> = {};
  /** Hook pass -> feature -> smoothed measured ms (from attribution frames). */
  private readonly shares = new Map<string, Map<string, number>>();
  private featureIds = new Set<string>();
  private lastFrameStart = 0;
  private over33 = 0;
  private newestGpuMs: number | null = null;
  private inFlight = 0;

  constructor(
    private readonly device: GPUDevice,
    timestamps: boolean,
  ) {
    if (timestamps) {
      this.querySet = device.createQuerySet({ label: 'perf.timestamps', type: 'timestamp', count: MAX_QUERIES });
      this.resolveBuffer = device.createBuffer({ label: 'perf.resolve', size: MAX_QUERIES * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    } else {
      this.querySet = null;
      this.resolveBuffer = null;
    }
  }

  setFeatureIds(ids: string[]): void {
    this.featureIds = new Set(ids);
  }

  /**
   * Declare which features drew inside a core-owned hook pass this frame (normal mode). `core` = the pass
   * also contains core draws: features then get their measured share and the remainder stays with the core.
   */
  setHookFeatures(passName: string, ids: string[], core = false): void {
    this.hookFeatures.set(passName, { ids, core });
  }

  /**
   * p50 / p99 / mean of every GPU pass over the window, ms. A pass that does not run in a frame (a staggered
   * shadow cascade, an attribution-only pass) counts as 0 for that frame, so `mean` is the amortised cost.
   */
  passStats(): Record<string, { p50: number; p99: number; mean: number }> {
    const out: Record<string, { p50: number; p99: number; mean: number }> = {};
    for (const [name, r] of this.passRings) out[name] = { p50: r.percentile(0.5), p99: r.percentile(0.99), mean: r.mean() };
    return out;
  }

  beginFrame(now: number): void {
    if (this.lastFrameStart > 0) {
      const d = now - this.lastFrameStart;
      this.raf.push(d);
      if (d >= 33) this.over33++;
    }
    this.lastFrameStart = now;
    this.names = [];
    this.gaps = [];
    this.hookFeatures = new Map();
    this.cpuFrame = new Map();
  }

  gpuPass(name: string): GPURenderPassTimestampWrites | undefined {
    if (!this.querySet || this.names.length * 2 + 2 > MAX_QUERIES) return undefined;
    const i = this.names.length;
    this.names.push(name);
    return { querySet: this.querySet, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 };
  }

  /**
   * Mark GPU work that is encoded outside any pass at this point of the frame (a texture copy). It is
   * timed as the gap between the pass encoded before it and the pass encoded after it, so call it where
   * both neighbours are timestamped passes with nothing else between them and the marked work; several
   * marks in one gap count once. Without a timestamped pass on both sides the mark is dropped.
   */
  gpuGap(name: string): void {
    if (!this.querySet || this.names.length === 0) return;
    const prev = this.names.length - 1;
    if (this.gaps.some((g) => g.prev === prev)) return;
    this.gaps.push({ name, prev });
  }

  cpuBegin(name: string): void {
    this.cpuOpen.set(name, performance.now());
  }

  cpuEnd(name: string): void {
    const t0 = this.cpuOpen.get(name);
    if (t0 === undefined) return;
    this.cpuOpen.delete(name);
    this.cpuFrame.set(name, (this.cpuFrame.get(name) ?? 0) + performance.now() - t0);
  }

  counter(name: string, value: number): void {
    this.counters[name] = value;
  }

  /** Encode the query resolve at the end of the frame's command encoder. */
  resolve(encoder: GPUCommandEncoder): (() => void) | null {
    const cpu = this.cpuFrame;
    const frameCpu = cpu.get('frame') ?? cpu.get('core.render') ?? 0;
    this.cpu.push(frameCpu);
    if (!this.querySet || !this.resolveBuffer || this.names.length === 0 || this.inFlight > 4) {
      this.accumulateCpuOnly(cpu);
      return null;
    }
    const count = this.names.length * 2;
    const buffer = this.freeBuffers.pop() ?? this.device.createBuffer({ label: 'perf.readback', size: MAX_QUERIES * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    encoder.resolveQuerySet(this.querySet, 0, count, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, buffer, 0, count * 8);
    const pending: PendingFrame = { names: this.names, gaps: this.gaps, buffer, hookFeatures: this.hookFeatures, cpu };
    this.inFlight++;
    // Call after queue.submit().
    return () => {
      buffer.mapAsync(GPUMapMode.READ, 0, count * 8).then(
        () => {
          const t = new BigUint64Array(buffer.getMappedRange(0, count * 8).slice(0));
          buffer.unmap();
          this.freeBuffers.push(buffer);
          this.inFlight--;
          this.ingest(pending, t);
        },
        () => {
          this.inFlight--;
        },
      );
    };
  }

  private featureOf(name: string): string {
    const id = name.split('.')[0]!;
    return this.featureIds.has(id) ? id : 'core';
  }

  private accumulateCpuOnly(cpu: Map<string, number>): void {
    const perFeature = new Map<string, number>();
    for (const [name, ms] of cpu) {
      if (name === 'frame') continue;
      const f = this.featureOf(name);
      perFeature.set(f, (perFeature.get(f) ?? 0) + ms);
    }
    for (const [f, ms] of perFeature) this.ringOf(this.featureCpu, f).push(ms);
  }

  private ringOf(map: Map<string, Ring>, key: string): Ring {
    let r = map.get(key);
    if (!r) {
      r = new Ring();
      map.set(key, r);
    }
    return r;
  }

  private ingest(frame: PendingFrame, t: BigUint64Array): void {
    const passMs = new Map<string, number>();
    let total = 0;
    for (let i = 0; i < frame.names.length; i++) {
      const a = t[2 * i]!;
      const b = t[2 * i + 1]!;
      // A pass that recorded nothing (or a wrapped clock) reports 0.
      const ms = b > a ? Number(b - a) / 1e6 : 0;
      if (ms > 1000) continue;
      const name = frame.names[i]!;
      passMs.set(name, (passMs.get(name) ?? 0) + ms);
      total += ms;
    }
    // Marked gaps: end of the pass before the work -> begin of the pass after it.
    for (const g of frame.gaps) {
      if (g.prev + 1 >= frame.names.length) continue;
      const a = t[2 * g.prev + 1]!;
      const b = t[2 * g.prev + 2]!;
      if (a === 0n || b <= a) continue;
      const ms = Number(b - a) / 1e6;
      if (ms > 1000) continue;
      passMs.set(g.name, (passMs.get(g.name) ?? 0) + ms);
      total += ms;
    }
    this.gpu.push(total);
    this.newestGpuMs = total;

    const featureMs = new Map<string, number>();
    const add = (f: string, ms: number): void => {
      featureMs.set(f, (featureMs.get(f) ?? 0) + ms);
    };
    for (const [name, ms] of passMs) {
      const split = frame.hookFeatures.get(name);
      if (split && split.ids.length > 0) {
        const shares = this.shares.get(name.replace(/^core\./, ''));
        let sum = 0;
        for (const id of split.ids) sum += shares?.get(id) ?? 0;
        if (split.core) {
          // Core draws share the pass: features keep their measured cost, the core gets the rest.
          const k = sum > ms && sum > 0 ? ms / sum : 1;
          for (const id of split.ids) add(id, (shares?.get(id) ?? 0) * k);
          add('core', Math.max(0, ms - sum * k));
        } else {
          for (const id of split.ids) add(id, sum > 0 ? (ms * (shares?.get(id) ?? 0)) / sum : ms / split.ids.length);
        }
        continue;
      }
      const f = this.featureOf(name);
      add(f, ms);
      if (f !== 'core') {
        // `<feature>.<hook>` from an attribution frame refreshes the shares of that hook pass.
        const hook = name.slice(f.length + 1);
        let m = this.shares.get(hook);
        if (!m) {
          m = new Map();
          this.shares.set(hook, m);
        }
        const prev = m.get(f);
        m.set(f, prev === undefined ? ms : prev + (ms - prev) * 0.3);
      }
    }
    // Every known pass gets one sample per frame (0 when it did not run), so means are amortised costs.
    for (const name of passMs.keys()) this.ringOf(this.passRings, name);
    for (const [name, ring] of this.passRings) ring.push(passMs.get(name) ?? 0);
    for (const id of ['core', ...this.featureIds]) this.ringOf(this.featureGpu, id).push(featureMs.get(id) ?? 0);
    this.accumulateCpuOnly(frame.cpu);

    const passes: Record<string, { gpuMs: number; cpuMs: number }> = {};
    for (const [name, ms] of passMs) passes[name] = { gpuMs: ms, cpuMs: frame.cpu.get(name) ?? 0 };
    for (const [name, ms] of frame.cpu) if (!passes[name]) passes[name] = { gpuMs: 0, cpuMs: ms };
    this.latestPasses = passes;
  }

  /** Newest summed GPU time (ms), returned once (null when nothing new arrived since the last call). */
  takeGpuMs(): number | null {
    const v = this.newestGpuMs;
    this.newestGpuMs = null;
    return v;
  }

  reset(): void {
    this.raf.clear();
    this.cpu.clear();
    this.gpu.clear();
    for (const r of this.featureGpu.values()) r.clear();
    for (const r of this.featureCpu.values()) r.clear();
    for (const r of this.passRings.values()) r.clear();
    this.over33 = 0;
  }

  snapshot(qualityScale: number, renderScale: number): PerfSnapshot {
    const features: Record<string, { gpuMs: number; cpuMs: number }> = {};
    for (const id of ['core', ...this.featureIds]) {
      features[id] = { gpuMs: this.featureGpu.get(id)?.percentile(0.99) ?? 0, cpuMs: this.featureCpu.get(id)?.percentile(0.99) ?? 0 };
    }
    return {
      raf: { p50: this.raf.percentile(0.5), p95: this.raf.percentile(0.95), p99: this.raf.percentile(0.99), max: this.raf.max(), count: this.raf.count, over33ms: this.over33 },
      cpu: { p50: this.cpu.percentile(0.5), p95: this.cpu.percentile(0.95), p99: this.cpu.percentile(0.99) },
      gpu: { p50: this.gpu.percentile(0.5), p95: this.gpu.percentile(0.95), p99: this.gpu.percentile(0.99) },
      passes: this.latestPasses,
      features,
      qualityScale,
      counters: { ...this.counters, gpuSamples: this.gpu.count },
      renderScale,
    };
  }
}
