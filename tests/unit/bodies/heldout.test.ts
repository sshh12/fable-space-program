/**
 * The STAGED orbits against held-out JPL Horizons truth (tests/unit/bodies/horizons-heldout.json: 40 instants per
 * body inside the validity window, off the fit's sampling grid, at the game's clock), judged with
 * tools/bodies/tolerances.json: the committed check that does not rely on the fit's own residuals or on the
 * git-ignored cache.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OrbitDef } from '../../../src/core/contracts/defs';
import { DEG, angleBetween, len, orbitState, sub, type V3 } from '../../../tools/bodies/lib/kepler.mjs';

const ROOT = join(__dirname, '../../..');
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
interface Staged {
  parent: string | null;
  mu: number;
  orbit: OrbitDef;
  rotation: { mode: string; poleRaDeg?: number; poleDecDeg?: number };
}
const staged = (id: string): Staged => readJson(`data/staged/bodies/${id}.json`) as Staged;
const truth = readJson('tests/unit/bodies/horizons-heldout.json') as { ttMinusUtcS: number; bodies: Record<string, { rows: number[][] }> };
const tol = readJson('tools/bodies/tolerances.json') as {
  classes: Record<string, { angleDeg: number; radial: number }>;
  bodies: { id: string; class: string; angleDeg?: number; radial?: number }[];
};

function stateOf(id: string, ut: number): { r: V3; v: V3 } {
  const b = staged(id);
  const p = staged(b.parent!);
  const parentPole = p.rotation.mode === 'none' ? null : { raDeg: p.rotation.poleRaDeg!, decDeg: p.rotation.poleDecDeg! };
  return orbitState(b.orbit, ut, { muSum: p.mu + b.mu, parentPole });
}

function worst(id: string): { angleDeg: number; radial: number; velocity: number } {
  let angleDeg = 0;
  let radial = 0;
  let velocity = 0;
  for (const [ut, x, y, z, vx, vy, vz] of truth.bodies[id]!.rows as [number, number, number, number, number, number, number][]) {
    const m = stateOf(id, ut);
    const r: V3 = [x, y, z];
    const v: V3 = [vx, vy, vz];
    angleDeg = Math.max(angleDeg, angleBetween(m.r, r) / DEG);
    radial = Math.max(radial, Math.abs(len(m.r) - len(r)) / len(r));
    velocity = Math.max(velocity, len(sub(m.v, v)) / len(v));
  }
  return { angleDeg, radial, velocity };
}

describe('staged orbits against held-out Horizons truth', () => {
  it('the truth file is at the game clock (TT - UTC = 69.184 s) and covers every body but the Sun', () => {
    expect(truth.ttMinusUtcS).toBe(69.184);
    expect(Object.keys(truth.bodies).length).toBe(31);
    for (const b of Object.values(truth.bodies)) expect(b.rows.length).toBe(40);
  });

  const judged = tol.bodies.filter((r) => r.class !== 'pinned').map((r) => r.id);
  it.each(judged)('%s: inside its tolerance row; velocity consistent with the position error', (id) => {
    const row = tol.bodies.find((r) => r.id === id)!;
    const cls = tol.classes[row.class]!;
    const bound = { angleDeg: row.angleDeg ?? cls.angleDeg, radial: row.radial ?? cls.radial };
    const w = worst(id);
    expect(w.angleDeg).toBeLessThanOrEqual(bound.angleDeg);
    expect(w.radial).toBeLessThanOrEqual(bound.radial);
    // a velocity error beyond what the direction and distance errors imply would be a velocity defect
    expect(w.velocity).toBeLessThanOrEqual(2 * Math.sin((bound.angleDeg * DEG) / 2) + 2 * bound.radial + 0.005);
  });

  it('Earth (pinned v1 formula) is off by the precession since J2000 only: under 0.85 deg, distance within 0.01 %', () => {
    const w = worst('earth');
    expect(w.angleDeg).toBeLessThan(0.85);
    expect(w.angleDeg).toBeGreaterThan(0.4);
    expect(w.radial).toBeLessThan(1e-4);
  });
});
