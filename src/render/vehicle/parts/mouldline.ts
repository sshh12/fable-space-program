/**
 * The capsule outer mould line as modelled, derived ONLY from the shared CapsuleMouldLineDef section
 * (data/defs/visuals/shared/*.json). The capsule exterior, the adapter seat under its heat shield and the
 * boost cover over it all read this module, so they agree with each other and with the cockpit interior.
 *
 * Surface used: the file's profile points are on it exactly. Between the heat-shield sample points the
 * surface is the sphere of the file's `radiusOfCurvature` through the apex (the straight chords between the
 * samples sag up to 4.2 mm inside that sphere; every sample point lies within 1.6 mm of it), blended into
 * the sampled shoulder. From the maximum diameter upward it is the profile polyline (cone, apex tunnel).
 */
import type { CapsuleMouldLineDef, DefLibrary } from '@/core/contracts/defs';
import { getSection } from '@/core/defs/loader';

export function mouldLine(defs: DefLibrary, key: string): CapsuleMouldLineDef {
  return getSection<CapsuleMouldLineDef>(defs, key);
}

/** Height of the heat-shield surface at radius r (r between 0 and the maximum radius). */
export function shieldY(ml: CapsuleMouldLineDef, r: number): number {
  const pts = ml.profile;
  const R = ml.heatShield.radiusOfCurvature;
  const sphere = ml.heatShield.apexY + (R - Math.sqrt(Math.max(0, R * R - r * r)));
  // Polyline through the samples.
  let poly = pts[0]![1];
  let seg = 0;
  for (let i = 0; i + 1 < pts.length && pts[i + 1]![1] <= ml.heatShield.maxDiameterY + 1e-9; i++) {
    if (r >= pts[i]![0]) {
      const t = Math.min(1, (r - pts[i]![0]) / Math.max(1e-9, pts[i + 1]![0] - pts[i]![0]));
      poly = pts[i]![1] + (pts[i + 1]![1] - pts[i]![1]) * t;
      seg = i;
    }
  }
  // Correction that makes the sphere pass through the bracketing samples exactly: the sample's offset
  // from the sphere, interpolated along the segment (zero on the dome, about 1.6 mm at the shoulder).
  const a = pts[seg]!;
  const c = pts[seg + 1]!;
  const off = (p: [number, number]): number => p[1] - (ml.heatShield.apexY + (R - Math.sqrt(Math.max(0, R * R - p[0] * p[0]))));
  const t = Math.min(1, Math.max(0, (r - a[0]) / Math.max(1e-9, c[0] - a[0])));
  const corrected = sphere + off(a) + (off(c) - off(a)) * t;
  // Past the last dome sample the sphere no longer describes the shoulder: follow the polyline there.
  const last = shoulderStart(ml);
  return r > last ? poly : corrected;
}

/** Radius beyond which the profile leaves the sphere by more than 2 mm (start of the sampled shoulder). */
export function shoulderStart(ml: CapsuleMouldLineDef): number {
  const R = ml.heatShield.radiusOfCurvature;
  let last = 0;
  for (const [r, y] of ml.profile) {
    if (y > ml.heatShield.maxDiameterY + 1e-9) break;
    const sphere = ml.heatShield.apexY + (R - Math.sqrt(Math.max(0, R * R - r * r)));
    if (Math.abs(y - sphere) <= 0.002) last = r;
    else break;
  }
  return last;
}

/** Radius of the back shell (cone and apex tunnel) at height y >= the maximum-diameter plane. */
export function shellRadius(ml: CapsuleMouldLineDef, y: number): number {
  const pts = ml.profile;
  let start = 0;
  while (start + 1 < pts.length && pts[start]![1] < ml.heatShield.maxDiameterY - 1e-9) start++;
  for (let i = start; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const c = pts[i + 1]!;
    if (y <= c[1] + 1e-9) {
      const t = c[1] - a[1] < 1e-9 ? 0 : Math.min(1, Math.max(0, (y - a[1]) / (c[1] - a[1])));
      return a[0] + (c[0] - a[0]) * t;
    }
  }
  return pts[pts.length - 1]![0];
}

/** Dense [r, y] contour of the heat shield from the apex to the maximum diameter (`steps` rings per sample span). */
export function shieldContour(ml: CapsuleMouldLineDef, steps: number): [number, number][] {
  const out: [number, number][] = [];
  const pts = ml.profile.filter((p) => p[1] <= ml.heatShield.maxDiameterY + 1e-9);
  for (let i = 0; i + 1 < pts.length; i++) {
    const n = pts[i + 1]![0] - pts[i]![0] < 0.12 ? 1 : steps;
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const r = pts[i]![0] + ((pts[i + 1]![0] - pts[i]![0]) * k) / n;
      out.push([r, shieldY(ml, r)]);
    }
  }
  return out;
}
