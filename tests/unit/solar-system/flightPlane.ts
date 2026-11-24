/**
 * The departure plane of the transfer flights (tests/unit/solar-system/transferFlight.test.ts): the parking orbit a
 * player launches into for a window, from the pilot's own porkchop. A module of its own so tools can print it.
 */
import type { BodySnapshot } from '../../../src/core/contracts/sim';
import { v3 } from '../../../src/core/math/vec3';
import { MOON_FLYBY_SHARE, TransferPilot } from '../../../src/pilot/generic/transfer';
import { bestWindow, captureDeltaVFromExcess, ejectionDeltaV, meanOrbit, synodic } from '../../../src/pilot/generic/transferMath';
import { loadStaged } from './fixtures';

/**
 * The parking orbit a player launches into for a departure toward `planetId` soon after `startUt`: the plane that
 * holds the outgoing asymptote of the window the pilot will choose (its own porkchop, coplanar costs), at the
 * scenario's inclination or, when the asymptote lies further from the equator, one degree more than its
 * declination (a pad at the scenario's latitude reaches any inclination above it). Inclination and node, degrees,
 * in the Earth's equatorial frame (the ROOT axes: the staged Earth's pole is +Z).
 */
export async function departurePlane(targetId: string, startUt: number, floorInclinationDeg: number, parkingRadius: number): Promise<{ inclinationDeg: number; lanDeg: number }> {
  const { defs, system } = await loadStaged();
  const snaps = system.buildBodySnapshots(startUt);
  const by = (id: string): BodySnapshot => snaps.find((b) => b.id === id)!;
  const origin = by('earth');
  const star = by(defs.bodies['earth']!.parent!);
  const planetId = defs.bodies[targetId]!.parent === star.id ? targetId : defs.bodies[targetId]!.parent!;
  const planet = by(planetId);
  const muS = defs.bodies[star.id]!.mu;
  const muO = defs.bodies['earth']!.mu;
  const muP = defs.bodies[planetId]!.mu;
  // the pilot's arrival costs: the capture at the planet, or for a moon the speed relative to it where the flyby crosses its orbit
  const pdef = defs.bodies[planetId]!;
  const rPeri = (pdef.shape ? pdef.shape.equatorialRadius : pdef.radius) + TransferPilot.defaultPeriapsisAltitude(defs, planetId);
  const rp = planetId === targetId ? rPeri : Math.max(rPeri, MOON_FLYBY_SHARE * meanOrbit(by(targetId), planet, muP).a);
  const ra = Math.max(1.01 * rp, 0.3 * (planet.soiRadius ?? 0));
  const arriveCost = planetId === targetId ? (vinf: number): number => captureDeltaVFromExcess(muP, vinf, rp, ra) : (vinf: number): number => Math.sqrt(vinf * vinf + (2 * muP) / rp) - Math.sqrt(muP / rp);
  const fromUt = startUt + 2 * 3600 + 3600;
  const arc = bestWindow({
    origin,
    planet,
    parent: star,
    muParent: muS,
    departCost: (vinf) => ejectionDeltaV(muO, parkingRadius, v3.len(vinf)),
    arriveCost,
    fromUt,
    toUt: fromUt + 0.8 * synodic(muS, meanOrbit(origin, star, muS).a, meanOrbit(planet, star, muS).a),
  })!;
  const s = v3.normalize(arc.vInfDepart);
  const dec = Math.asin(s.z);
  const ra0 = Math.atan2(s.y, s.x);
  const inc = Math.max((floorInclinationDeg * Math.PI) / 180, Math.abs(dec) + Math.PI / 180);
  const lan = ra0 + Math.asin(-Math.tan(dec) / Math.tan(inc));
  return { inclinationDeg: (inc * 180) / Math.PI, lanDeg: ((((lan * 180) / Math.PI) % 360) + 360) % 360 };
}
