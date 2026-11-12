/**
 * The staged physical atmospheres through the runtime models (src/sim/bodies/atmosphere.ts): every one
 * evaluates, density falls with altitude, the rails boundary (simTop) sits where the model density reaches
 * Earth's density at its own simTop, and the giants' floor is below their 1-bar reference.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BodyDef } from '../../../src/core/contracts/defs';
import { atmosphereAt, atmosphereModelRaw } from '../../../src/sim/bodies/atmosphere';
import { convectiveFlux, radiativeFlux, stagnationFlux } from '../../../src/sim/dynamics/thermal';
import { EARTH_SIMTOP_DENSITY } from '../../../tools/bodies/lib/atmospheres.mjs';
import { STAGED_BODY_FILES } from './stagedBodies.generated';

const ROOT = join(__dirname, '../../..');
const liveEarth = JSON.parse(readFileSync(join(ROOT, 'data/defs/bodies/earth.json'), 'utf8')) as BodyDef;
/** A staged body as the runtime sees it (the atmosphere is inline; the rest is not read by the model). */
const asBody = (id: keyof typeof STAGED_BODY_FILES): BodyDef => STAGED_BODY_FILES[id] as unknown as BodyDef;

describe('staged atmospheres', () => {
  it("the generator's reference density is Earth's density at its v1 simTop in the runtime USSA-76 model", () => {
    const rho = atmosphereModelRaw(liveEarth, liveEarth.atmosphere!.simTop).density;
    expect(Math.abs(rho / EARTH_SIMTOP_DENSITY - 1)).toBeLessThan(1e-9);
  });

  const withAtmosphere = (Object.keys(STAGED_BODY_FILES) as (keyof typeof STAGED_BODY_FILES)[]).filter((id) => id !== 'earth' && STAGED_BODY_FILES[id].atmosphere !== null);

  it('the bodies with a physical atmosphere are Venus, Mars, Titan and the four giants', () => {
    expect([...withAtmosphere].sort()).toEqual(['jupiter', 'mars', 'neptune', 'saturn', 'titan', 'uranus', 'venus']);
  });

  it.each(withAtmosphere)('%s: evaluates, density falls with altitude, simTop at the reference density', (id) => {
    const body = asBody(id);
    const atm = body.atmosphere!;
    let prev = Infinity;
    for (let h = 0; h < atm.simTop; h += atm.simTop / 50) {
      const s = atmosphereModelRaw(body, h);
      expect(s.density).toBeGreaterThan(0);
      expect(s.density).toBeLessThan(prev);
      expect(s.temperature).toBeGreaterThan(0);
      prev = s.density;
    }
    const top = atmosphereModelRaw(body, atm.simTop).density;
    // simTop is written to the metre
    expect(Math.abs(top / EARTH_SIMTOP_DENSITY - 1)).toBeLessThan(1e-3);
    expect(atm.gamma).toBeGreaterThan(1);
    expect(atm.gamma).toBeLessThan(5 / 3 + 1e-9);
    expect(atm.heating.kConv).toBeGreaterThan(0);
  });

  it.each(withAtmosphere)('%s: drag inputs and convective heating work in the runtime (radiative heating: none for this gas)', (id) => {
    const body = asBody(id);
    const atm = body.atmosphere!;
    const h = atm.simTop / 3;
    const s = atmosphereAt(body, h);
    expect(s.density).toBeGreaterThan(0);
    expect(s.pressure).toBeGreaterThan(0);
    expect(s.speedOfSound).toBeGreaterThan(100);
    expect(s.speedOfSound).toBeLessThan(3000);
    // 6 km/s through the density at a third of the rails boundary, 1 m nose radius
    const q = stagnationFlux(atm.heating, s.density, 6000, 1);
    expect(q).toBeGreaterThan(0);
    expect(convectiveFlux(atm.heating, s.density, 6000, 1)).toBe(q);
    expect(radiativeFlux(atm.heating, s.density, 12000, 1)).toBe(0);
  });

  it('the giants have no surface and a floor below the 1-bar level', () => {
    for (const id of ['jupiter', 'saturn', 'uranus', 'neptune'] as const) {
      const b = STAGED_BODY_FILES[id];
      expect(b.surface).toBe('none');
      expect(b.atmosphere!.floorAltitude!).toBeLessThan(0);
      expect(b.shape!.polarRadius).toBeLessThan(b.shape!.equatorialRadius);
    }
  });
});
