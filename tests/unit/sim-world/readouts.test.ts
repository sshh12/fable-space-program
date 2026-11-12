/**
 * Read-outs that must describe the place the vessel is at now: the Mach number outside an atmosphere
 * (request flight-ui-6).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { active, flatTerrain, loadLibrary, makeSim } from './helpers';

let defs: DefLibrary;
let terrain: TerrainProvider;
beforeAll(async () => {
  defs = await loadLibrary();
  terrain = flatTerrain(defs, { earth: -100, moon: 0 });
});

describe('Mach number', () => {
  it('reads 0 in orbit about the Moon and on the way there, and a real value under the drogues', async () => {
    for (const id of ['qa-lunar-orbit', 'qa-translunar', 'qa-leo']) {
      const sim = await makeSim(defs, id, terrain);
      for (let i = 0; i < 8; i++) sim.step();
      const s = sim.peek();
      expect(active(s).aero.airDensity, id).toBe(0);
      expect(active(s).aero.mach, id).toBe(0);
      expect(s.readouts.mach, id).toBe(0);
      expect(s.readouts.speedOrbital, id).toBeGreaterThan(500);
    }
    const sim = await makeSim(defs, 'qa-drogues', terrain);
    for (let i = 0; i < 8; i++) sim.step();
    const s = sim.peek();
    expect(active(s).aero.airDensity).toBeGreaterThan(0.1);
    expect(s.readouts.mach).toBeGreaterThan(0.1);
    expect(s.readouts.mach).toBeLessThan(1);
    expect(active(s).aero.mach).toBe(s.readouts.mach);
  });
});
