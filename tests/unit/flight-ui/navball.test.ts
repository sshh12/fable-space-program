import { describe, expect, it } from 'vitest';
import { mat4 } from '@/core/math/mat';
import { quat, type Quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { BALL_RADIUS_FRACTION, ballDirectionHorizon, ballTextureUv, markerInstances, pitchHeadingOf, projectMarker } from '@/ui';

/** VES -> horizon (ENU) for navball angles: heading clockwise from north, roll right positive. */
function attitude(pitchDeg: number, headingDeg: number, rollDeg: number): Quat {
  const p = pitchDeg * DEG;
  const h = headingDeg * DEG;
  const nose: Vec3 = { x: Math.cos(p) * Math.sin(h), y: Math.cos(p) * Math.cos(h), z: Math.sin(p) };
  let dorsal = v3.reject(v3.unitZ(), nose);
  dorsal = v3.len(dorsal) < 1e-9 ? v3.neg({ x: Math.sin(h), y: Math.cos(h), z: 0 }) : v3.normalize(dorsal);
  // Roll right = rotation about the nose (+Y) by +roll: the dorsal side tilts toward starboard.
  dorsal = quat.rotate(quat.fromAxisAngle(nose, rollDeg * DEG), dorsal);
  return quat.fromBasis(v3.cross(nose, dorsal), nose, dorsal);
}

const pitchAt = (q: Quat, sx: number, sy: number): number => pitchHeadingOf(ballDirectionHorizon(sx, sy, q)!).pitchDeg;

/** Normalised screen y of the horizon (pitch 0) in column sx, by bisection along the column. */
function horizonY(q: Quat, sx: number): number {
  const half = Math.sqrt(1 - sx * sx) * 0.98;
  let lo = -half;
  let hi = half;
  const sLo = Math.sign(pitchAt(q, sx, lo));
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (Math.sign(pitchAt(q, sx, mid)) === sLo) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

describe('navball attitude', () => {
  it('nose at the zenith shows pitch 90 at the reticle', () => {
    const q = attitude(90, 30, 0);
    // asin near 1 is ill-conditioned: 90 deg to 1e-5 deg.
    expect(pitchAt(q, 0, 0)).toBeCloseTo(90, 5);
    // Everything around the reticle is sky, 80 degrees and above at a tenth of the radius.
    for (const [x, y] of [[0.1, 0], [-0.1, 0], [0, 0.1], [0, -0.1]] as const) expect(pitchAt(q, x, y)).toBeGreaterThan(84);
    expect(ballTextureUv(ballDirectionHorizon(0, 0, q)!)[1]).toBeCloseTo(0, 7);
  });

  it('heading 090 with wings level shows a horizontal horizon, sky on top, heading increasing to the right', () => {
    const q = attitude(0, 90, 0);
    const centre = pitchHeadingOf(ballDirectionHorizon(0, 0, q)!);
    expect(centre.pitchDeg).toBeCloseTo(0, 9);
    expect(centre.headingDeg).toBeCloseTo(90, 9);
    expect(pitchAt(q, 0, 0.5)).toBeGreaterThan(25);
    expect(pitchAt(q, 0, -0.5)).toBeLessThan(-25);
    expect(horizonY(q, -0.6)).toBeCloseTo(0, 6);
    expect(horizonY(q, 0.6)).toBeCloseTo(0, 6);
    expect(pitchHeadingOf(ballDirectionHorizon(0.5, 0, q)!).headingDeg).toBeCloseTo(120, 6);
    expect(pitchHeadingOf(ballDirectionHorizon(-0.5, 0, q)!).headingDeg).toBeCloseTo(60, 6);
  });

  it('rolling right rotates the horizon counter-clockwise (its right end rises)', () => {
    const q = attitude(0, 90, 30);
    const yRight = horizonY(q, 0.5);
    const yLeft = horizonY(q, -0.5);
    expect(yRight).toBeGreaterThan(0);
    expect(yLeft).toBeLessThan(0);
    // A great circle through the view axis projects to a straight line: slope = tan(roll).
    expect(yRight / 0.5).toBeCloseTo(Math.tan(30 * DEG), 6);
    // Sky stays on the side the dorsal axis points to: up-left after a right roll.
    expect(pitchAt(q, -0.35, 0.35)).toBeGreaterThan(0);
    expect(pitchAt(q, 0.35, -0.35)).toBeLessThan(0);
  });

  it('pitching up moves the horizon down on the ball', () => {
    const q = attitude(20, 90, 0);
    expect(horizonY(q, 0)).toBeCloseTo(-Math.sin(20 * DEG), 6);
  });
});

describe('navball marker projection', () => {
  it('matches an independent orthographic view projection to well within 1 px', () => {
    const size = 512;
    // View frame of the navball camera in VES coordinates: right = +X, up = +Z, looking along +Y (view -Z).
    const qViewToVes = quat.fromBasis(v3.unitX(), v3.unitZ(), v3.new(0, -1, 0));
    const view = mat4.viewRotation(qViewToVes);
    const R = BALL_RADIUS_FRACTION;
    const ortho = new Float64Array([R, 0, 0, 0, 0, R, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const vp = mat4.mul(ortho, view);
    let seed = 12345;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
    let checked = 0;
    for (let i = 0; i < 2000; i++) {
      const d = v3.normalize(v3.new(rnd(), rnd(), rnd()));
      const clip = mat4.transformPoint(vp, d);
      const px = ((clip.x / clip.w + 1) / 2) * size;
      const py = ((1 - clip.y / clip.w) / 2) * size;
      const m = projectMarker(d, size);
      // Visible hemisphere = in front of the nose = toward the navball camera's far side (view z < 0).
      const viewZ = mat4.transformPoint(view, d).z;
      expect(m.visible).toBe(viewZ < 0);
      expect(Math.abs(m.px - px)).toBeLessThan(1e-6);
      expect(Math.abs(m.py - py)).toBeLessThan(1e-6);
      checked++;
    }
    expect(checked).toBe(2000);
  });

  it('places every marker of NavballMarkers on the visible hemisphere and draws the reticle last, on top', () => {
    const prograde = v3.normalize(v3.new(0.2, 0.9, 0.1));
    const markers = {
      prograde,
      retrograde: v3.neg(prograde),
      normal: v3.normalize(v3.new(0, 0.05, 1)),
      antinormal: v3.new(0, -0.1, -1),
      radialOut: v3.new(1, 0, 0),
      radialIn: v3.new(-1, 0, 0),
      maneuver: v3.normalize(v3.new(-0.3, 0.8, 0.2)),
      target: v3.normalize(v3.new(0.5, 0.5, -0.5)),
      antiTarget: v3.normalize(v3.new(-0.5, -0.5, 0.5)),
      liftVector: v3.normalize(v3.new(0, 0.6, 0.8)),
    };
    const inst = markerInstances(markers);
    expect(inst[inst.length - 1]!.name).toBe('reticle');
    expect(inst.filter((m) => m.name === 'reticle')).toHaveLength(1);
    const names = inst.slice(0, -1).map((m) => m.name).sort();
    // Behind the nose (y <= 0): retrograde, antinormal, both radials (y = 0 is the limb), antiTarget.
    expect(names).toEqual(['liftVector', 'maneuver', 'normal', 'prograde', 'target'].sort());
    const p = inst.find((m) => m.name === 'prograde')!;
    expect(p.sx).toBeCloseTo(prograde.x, 12);
    expect(p.sy).toBeCloseTo(prograde.z, 12);
    // Limb fade: a marker barely in front is faint.
    expect(inst.find((m) => m.name === 'normal')!.alpha).toBeLessThan(0.8);
    expect(p.alpha).toBe(1);
  });
});
