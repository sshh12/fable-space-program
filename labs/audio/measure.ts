/**
 * In-page measurement of offline renders (so Playwright receives numbers, not megabytes of samples) and
 * WAV encoding for the listen-proof clips.
 */
import { audioAnalysis, type OfflineRender, type TapName } from '@/audio';

export interface WindowLevels {
  from: number;
  to: number;
  rms: number;
  rmsDb: number;
  peak: number;
  low: number;
  mid: number;
  high: number;
  highDb: number;
}

export interface TapMeasure {
  maxAbs: number;
  windows: WindowLevels[];
}

export function measureTap(x: Float32Array, sampleRate: number, windows: [number, number][]): TapMeasure {
  let maxAbs = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]!);
    if (a > maxAbs) maxAbs = a;
  }
  return {
    maxAbs,
    windows: windows.map(([from, to]) => {
      const l = audioAnalysis.levelsOf(x, sampleRate, Math.round(from * sampleRate), Math.round(to * sampleRate));
      return { from, to, ...l, rmsDb: audioAnalysis.toDb(l.rms), highDb: audioAnalysis.toDb(l.high) };
    }),
  };
}

export function measureRender(r: OfflineRender, taps: TapName[], windows: [number, number][]): Record<string, TapMeasure> {
  const out: Record<string, TapMeasure> = {};
  for (const t of taps) {
    if (t === 'master') {
      const [L, R] = r.master;
      const mono = new Float32Array(L.length);
      let peak = 0;
      for (let i = 0; i < L.length; i++) {
        mono[i] = 0.5 * (L[i]! + R[i]!);
        peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
      }
      out[t] = { ...measureTap(mono, r.sampleRate, windows), maxAbs: peak };
      continue;
    }
    const x = r.taps[t];
    if (!x) throw new Error(`tap ${t} was not captured`);
    const m = measureTap(x, r.sampleRate, windows);
    // With a stereo capture the peak is the true sample peak of either side (a panned source is louder there).
    const st = r.stereo[t];
    out[t] = st ? { ...m, maxAbs: Math.max(audioAnalysis.peakOf(st[0]), audioAnalysis.peakOf(st[1])) } : m;
  }
  return out;
}

/** The master before its soft ceiling: true peak, and the share of samples that reach the ceiling's knee. */
export function preCeilingLevels(r: OfflineRender, linearUntil: number): { peak: number; kneeShare: number } {
  const [L, R] = r.preCeiling;
  let peak = 0;
  let knee = 0;
  for (let i = 0; i < L.length; i++) {
    const a = Math.max(Math.abs(L[i]!), Math.abs(R[i]!));
    if (a > peak) peak = a;
    if (a > linearUntil) knee++;
  }
  return { peak, kneeShare: knee / L.length };
}

export function onset(r: OfflineRender, tap: TapName, opts: { from?: number; fraction?: number; win?: number }): number | null {
  const x = tap === 'master' ? r.master[0] : r.taps[tap];
  if (!x) throw new Error(`tap ${tap} was not captured`);
  return audioAnalysis.onsetTime(x, r.sampleRate, opts);
}

/** First time after `from` at which the tap's 2 ms envelope exceeds an absolute amplitude. */
export function onsetAbove(r: OfflineRender, tap: TapName, from: number, to: number, threshold: number): number | null {
  const x = tap === 'master' ? r.master[0] : r.taps[tap];
  if (!x) throw new Error(`tap ${tap} was not captured`);
  const win = Math.round(0.002 * r.sampleRate);
  for (let s = Math.round(from * r.sampleRate); s + win <= Math.min(x.length, Math.round(to * r.sampleRate)); s += win) {
    if (audioAnalysis.rmsOf(x, s, s + win) > threshold) return s / r.sampleRate;
  }
  return null;
}

export function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return a.length === b.length ? m : Infinity;
}

export interface ClipStats {
  durationS: number;
  peak: number;
  peakDbfs: number;
  rmsDbfs: number;
  spectralCentroidHz: number;
  lowDbfs: number;
  midDbfs: number;
  highDbfs: number;
}

export function clipStats(r: OfflineRender): ClipStats {
  const [L, R] = r.master;
  const mono = new Float32Array(L.length);
  let peak = 0;
  for (let i = 0; i < L.length; i++) {
    mono[i] = 0.5 * (L[i]! + R[i]!);
    peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
  }
  const l = audioAnalysis.levelsOf(mono, r.sampleRate);
  return {
    durationS: L.length / r.sampleRate,
    peak,
    peakDbfs: audioAnalysis.toDb(peak),
    rmsDbfs: audioAnalysis.toDb(l.rms),
    spectralCentroidHz: audioAnalysis.spectralCentroid(mono, r.sampleRate),
    lowDbfs: audioAnalysis.toDb(l.low),
    midDbfs: audioAnalysis.toDb(l.mid),
    highDbfs: audioAnalysis.toDb(l.high),
  };
}

/** 16-bit PCM stereo WAV of the master output, base64 (for transfer to the test runner). */
export function masterWavBase64(r: OfflineRender): string {
  const [L, R] = r.master;
  const n = L.length;
  const bytes = new Uint8Array(44 + n * 4);
  const dv = new DataView(bytes.buffer);
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i);
  };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + n * 4, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 2, true);
  dv.setUint32(24, r.sampleRate, true);
  dv.setUint32(28, r.sampleRate * 4, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    dv.setInt16(44 + i * 4, Math.max(-32768, Math.min(32767, Math.round(L[i]! * 32767))), true);
    dv.setInt16(46 + i * 4, Math.max(-32768, Math.min(32767, Math.round(R[i]! * 32767))), true);
  }
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}
