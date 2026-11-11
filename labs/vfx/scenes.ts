/**
 * Scene catalogue of the vfx lab. A scene chooses a site and a sun elevation, then builds vessels from the
 * real assembled parts and drives their module states with a script. Selected with ?scene=<name>.
 */
import type { DefLibrary, ModuleDef } from '@/core/contracts/defs';
import type { PartSnapshot } from '@/core/contracts/sim';
import { DEG, quat, v3, type Vec3 } from '@/core/math';
import { assembleVessel, splitForStage, vesselPartSnapshots, type Vessel } from '@/sim/vessel/public';
import { labAtmosphere, noseAlong, noseUp, stillAir, type LabScript, type LabSim, type LabSite, type LabVessel } from './labSim';

export interface SceneCamera {
  /** Point looked at, site ENU (m); yaw (deg, from north towards east) and pitch (deg) of the eye as seen from the target; distance (m). */
  target: Vec3;
  yawDeg: number;
  pitchDeg: number;
  distance: number;
  fovDeg?: number;
  /** Follow a vessel: the target is added to its position every frame. */
  follow?: string;
}

export interface SceneSetup {
  camera: SceneCamera;
  script?: LabScript;
  /** Extra controls for specs (window.__vfx.scene.<name>). */
  controls?: Record<string, (...args: number[]) => void>;
}

export interface SceneDef {
  site: LabSite;
  sunElevationDeg: number;
  /** 'land' / 'water': colour of the lab planet around the site. */
  ground: 'land' | 'water' | 'regolith';
  pad?: { radius: number; mountHeight: number; trenchHeadingDeg: number } | null;
  /** Forced EV100 (null = automatic exposure). */
  ev?: number | null;
  build(sim: LabSim): SceneSetup;
}

const num = (q: URLSearchParams, key: string, fallback: number): number => {
  const v = q.get(key);
  const n = v === null || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function earthSite(defs: DefLibrary): { bodyId: string; latDeg: number; lonDeg: number; padElevation: number; clampHeight: number; padRadius: number; trenchHeadingDeg: number } {
  const site = Object.values(defs.sites)[0]!;
  const pe = site.location.padElevation;
  const trench = site.structures.find((s) => /trench/i.test(s.model));
  return { bodyId: site.bodyId, latDeg: site.location.latDeg, lonDeg: site.location.lonDeg, padElevation: typeof pe === 'number' ? pe : 20, clampHeight: site.pad.clampHeight, padRadius: site.pad.flatRadius, trenchHeadingDeg: trench?.headingDeg ?? 90 };
}

const moonId = (defs: DefLibrary): string => Object.values(defs.bodies).find((b) => b.parent === defs.rootBodyId && b.gravityRole === 'attractor')?.id ?? defs.rootBodyId;

function stack(defs: DefLibrary, stagesAlreadyFired: number): { vessel: Vessel; parts: PartSnapshot[] } {
  const vehicleId = Object.keys(defs.vehicles)[0]!;
  const vessel = assembleVessel(defs, vehicleId, { stagesAlreadyFired });
  return { vessel, parts: vesselPartSnapshots(vessel) };
}

/** Lowest and highest y of the parts' bounds in the vessel frame (the stack stands along +Y). */
function yExtent(defs: DefLibrary, parts: PartSnapshot[]): { yMin: number; yMax: number } {
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const p of parts) {
    const b = defs.parts[p.def]!.bounds;
    for (const y of [b.yMin, b.yMax]) {
      const v = quat.rotate(p.localRot, { x: 0, y, z: 0 });
      yMin = Math.min(yMin, v.y + p.localPos.y);
      yMax = Math.max(yMax, v.y + p.localPos.y);
    }
  }
  return { yMin, yMax };
}

const engineModule = (defs: DefLibrary, partDef: string): Extract<ModuleDef, { type: 'engine' }> | null => {
  const m = defs.parts[partDef]?.modules.find((x) => x.type === 'engine');
  return m && m.type === 'engine' ? m : null;
};

const altitudeForKm = (km: number): number => km * 1000;

export function sceneFor(name: string, q: URLSearchParams, defs: DefLibrary): SceneDef {
  const earth = earthSite(defs);
  const night = q.get('night') === '1';
  const sun = num(q, 'sun', night ? -25 : 34);

  switch (name) {
    // ------------------------------------------------------------------------------------ engine
    // One engine alone, exhaust towards the east, at the altitude that gives the wanted ambient pressure
    // (?altkm=0|10|30|60|200, or ?p=<Pa> at 400 m). ?engine=<part def id>, ?throttle=0..1 (or 'min').
    case 'engine': {
      const partDef = q.get('engine') ?? 'atlas-9m';
      const altKm = num(q, 'altkm', 0);
      const alt = altKm > 0 ? altitudeForKm(altKm) : 400;
      return {
        site: { bodyId: earth.bodyId, latDeg: earth.latDeg, lonDeg: earth.lonDeg, alt },
        sunElevationDeg: sun,
        ground: 'land',
        build(sim) {
          const md = engineModule(defs, partDef);
          if (!md) throw new Error(`vfx lab: part "${partDef}" has no engine module`);
          const all = stack(defs, 0).parts;
          const part = all.find((p) => p.def === partDef);
          if (!part) throw new Error(`vfx lab: no part with def "${partDef}" in the vehicle`);
          const air = labAtmosphere(alt);
          const pressure = q.has('p') ? num(q, 'p', air.pressure) : altKm >= 150 ? 0 : air.pressure;
          const throttle = q.get('throttle') === 'min' ? (md.throttleable ? md.minThrottle : 1) : num(q, 'throttle', 1);
          const single: PartSnapshot = { ...part, localPos: v3.zero(), localRot: quat.identity() };
          // Exhaust (the nozzles' mean direction) towards the east: rotate the part so that its -Y points east.
          const v = sim.addVessel({ id: 'engine', parts: [single], qVesToEnu: noseAlong({ x: -1, y: 0, z: 0 }), aero: stillAir(pressure, air.density, air.temperature), boundingRadius: 8 });
          const nozzle = md.nozzles[0]!;
          v.enu = v3.neg(quat.rotate(v.qVesToEnu, v3.fromTuple(nozzle.pos)));
          sim.setEngines(v, undefined, { throttle });
          sim.throttle = throttle;
          const re = nozzle.exitDiameter / 2;
          const span = num(q, 'span', 56) * re;
          const fov = 40;
          return {
            camera: { target: { x: span * 0.42, y: 0, z: 0 }, yawDeg: 180, pitchDeg: 4, distance: (span * 0.5) / Math.tan((fov * DEG * 16) / 9 / 2) / 0.92, fovDeg: fov },
            controls: {
              throttle: (thr: number) => {
                sim.setEngines(v, undefined, { throttle: thr });
                sim.throttle = thr;
              },
              pressure: (p: number) => {
                v.aero = { ...v.aero, pressure: p };
                sim.setEngines(v, undefined, { throttle: sim.throttle });
              },
              ignite: () => {
                const t0 = sim.time;
                sim.script = (s, t) => {
                  const age = t - t0;
                  const thr = 1 - Math.exp(-age / Math.max(md.spoolUp, 0.02));
                  s.setEngines(v, undefined, { throttle: thr, ignitionAge: age });
                  s.throttle = thr;
                };
              },
              shutdown: () => {
                const t0 = sim.time;
                const thr0 = sim.throttle;
                sim.script = (s, t) => {
                  const age = t - t0;
                  const thr = thr0 * Math.exp(-age / Math.max(md.spoolDown, 0.02));
                  const off = thr < 0.01;
                  s.setEngines(v, undefined, { throttle: off ? 0 : thr, shutdownAge: off ? age : -1 });
                  s.throttle = off ? 0 : thr;
                };
              },
              gimbal: (gx: number, gz: number) => sim.setEngines(v, undefined, { throttle: sim.throttle, gimbal: [gx * DEG, gz * DEG] }),
            },
          };
        },
      };
    }

    // --------------------------------------------------------------------------------------- pad
    // The whole stack on the launch mount. Timeline (lab time): ignition at 1 s, clamp release 3 s later
    // = T+0, then a climb at the acceleration of a 1.3 thrust-to-weight vehicle that burns its mass away.
    case 'pad': {
      return {
        site: { bodyId: earth.bodyId, latDeg: earth.latDeg, lonDeg: earth.lonDeg, alt: earth.padElevation },
        sunElevationDeg: sun,
        ground: 'land',
        pad: { radius: earth.padRadius, mountHeight: earth.clampHeight, trenchHeadingDeg: earth.trenchHeadingDeg },
        build(sim) {
          const { parts } = stack(defs, 0);
          const ext = yExtent(defs, parts);
          const z0 = earth.clampHeight - ext.yMin;
          const v = sim.addVessel({ id: 'stack', parts, enu: { x: 0, y: 0, z: z0 }, qVesToEnu: noseUp(90), aero: stillAir(101325, 1.2, 288), situation: 'prelaunch', boundingRadius: 110 });
          const boosters = sim.engines(v).filter((e) => e.def.plume === sim.engines(v)[0]!.def.plume && e.part.def === sim.engines(v).find((x) => x.def.thrustVac > 3e6)?.part.def);
          const boosterDef = boosters[0]!.part.def;
          const tIgnite = num(q, 'ignite', 1);
          const tLift = tIgnite + 3;
          let ignited = false;
          let released = false;
          const script: LabScript = (s, t) => {
            const age = t - tIgnite;
            const thr = age > 0 ? 1 - Math.exp(-age / 1.2) : 0;
            const tl = Math.max(0, t - tLift);
            // a = g (1.3 / (1 - 0.0036 t) - 1): the mass falls by 0.36 % per second.
            const z = tl > 0 ? 9.81 * ((1.3 / 0.0036) * (tl + (1 / 0.0036 - tl) * Math.log(1 - 0.0036 * tl)) - 0.5 * tl * tl) : 0;
            const vz = tl > 0 ? 9.81 * (-(1.3 / 0.0036) * Math.log(1 - 0.0036 * tl) - tl) : 0;
            v.enu = { x: 0, y: 0, z: z0 + z };
            v.velEnu = { x: 0, y: 0, z: vz };
            const air = labAtmosphere(s.site.alt + z);
            v.aero = { ...stillAir(air.pressure, air.density, air.temperature), q: 0.5 * air.density * vz * vz, mach: vz / 340 };
            v.situation = tl > 0 ? 'flying' : 'prelaunch';
            s.setEngines(v, boosterDef, { throttle: thr, ignitionAge: age > 0 ? age : -1 });
            s.throttle = age > 0 ? 1 : 0;
            s.radarAltitude = earth.clampHeight + z;
            if (age > 0 && !ignited) {
              ignited = true;
              for (const e of boosters) s.emit({ type: 'engineIgnition', ut: s.ut, vesselId: v.id, partId: e.part.instanceId });
              s.emit({ type: 'stageFired', ut: s.ut, vesselId: v.id, stageIndex: 0, label: 'Launch' });
            }
            if (tl > 0 && !released) {
              released = true;
              s.emit({ type: 'clampsReleased', ut: s.ut, vesselId: v.id });
            }
          };
          sim.radarAltitude = earth.clampHeight;
          return {
            script,
            camera: { target: { x: 0, y: 0, z: 62 }, yawDeg: num(q, 'yaw', 152), pitchDeg: num(q, 'pitch', 1.5), distance: num(q, 'dist', 430), fovDeg: num(q, 'fov', 38) },
          };
        },
      };
    }

    // ------------------------------------------------------------------------------------ ascent
    // The stack climbing on its first stage at ?altkm (default 12) and ?speed (default 420 m/s), pitched
    // over by ?pitch degrees from the vertical towards the east.
    case 'ascent': {
      const altKm = num(q, 'altkm', 12);
      return {
        site: { bodyId: earth.bodyId, latDeg: earth.latDeg, lonDeg: earth.lonDeg, alt: earth.padElevation },
        sunElevationDeg: sun,
        ground: 'land',
        pad: q.get('pad') === '0' ? null : { radius: earth.padRadius, mountHeight: earth.clampHeight, trenchHeadingDeg: earth.trenchHeadingDeg },
        build(sim) {
          const { parts } = stack(defs, 1);
          const pitch = num(q, 'tilt', 18) * DEG;
          const speed = num(q, 'speed', 420);
          const dir = { x: Math.sin(pitch), y: 0, z: Math.cos(pitch) };
          const start = { x: num(q, 'east', 0), y: 0, z: altKm * 1000 - earth.padElevation };
          const v = sim.addVessel({ id: 'stack', parts, enu: start, velEnu: v3.scale(dir, speed), qVesToEnu: noseAlong(dir, { x: -1, y: 0, z: 0 }), boundingRadius: 110 });
          const boosterDef = sim.engines(v).find((x) => x.def.thrustVac > 3e6)!.part.def;
          const script: LabScript = (s) => {
            const air = labAtmosphere(s.site.alt + v.enu.z);
            const sp = v3.len(v.velEnu);
            v.aero = { ...stillAir(air.pressure, air.density, air.temperature), q: 0.5 * air.density * sp * sp, mach: sp / 300 };
            s.setEngines(v, boosterDef, { throttle: 1 });
            s.throttle = 1;
            s.radarAltitude = null;
          };
          script(sim, 0, 0);
          return {
            script,
            camera: { follow: 'stack', target: { x: 0, y: 0, z: -70 }, yawDeg: num(q, 'yaw', 200), pitchDeg: num(q, 'pitch', 8), distance: num(q, 'dist', 320), fovDeg: num(q, 'fov', 45) },
          };
        },
      };
    }

    default:
      return sceneExtra(name, q, defs, { earth, sun, moon: moonId(defs), stack: (n: number) => stack(defs, n), yExtent: (p: PartSnapshot[]) => yExtent(defs, p), split: (v: Vessel, i: number) => splitForStage(defs, v, i) });
  }
}

interface SceneHelpers {
  earth: ReturnType<typeof earthSite>;
  sun: number;
  moon: string;
  stack(n: number): { vessel: Vessel; parts: PartSnapshot[] };
  yExtent(parts: PartSnapshot[]): { yMin: number; yMax: number };
  split(v: Vessel, stage: number): { vessel: Vessel; spawned: Vessel[] };
}

function sceneExtra(name: string, _q: URLSearchParams, _defs: DefLibrary, _h: SceneHelpers): SceneDef {
  throw new Error(`vfx lab: unknown scene "${name}"`);
}

export type { LabVessel };
