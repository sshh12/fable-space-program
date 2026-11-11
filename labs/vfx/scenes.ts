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
          const boosterDef = sim.engines(v).find((x) => x.def.thrustVac > 3e6)!.part.def;
          const boosters = sim.engines(v, boosterDef);
          const tIgnite = num(q, 'ignite', 1);
          const tLift = tIgnite + 3;
          let ignited = false;
          let released = false;
          // Specs switch the engines off and on again with the scene paused (controls.engines) to measure what
          // of the picture is the plume.
          let burning = true;
          let last = { throttle: 0, ignitionAge: -1 };
          const script: LabScript = (s, t) => {
            const age = t - tIgnite;
            const thr = age > 0 ? 1 - Math.exp(-age / 1.2) : 0;
            last = { throttle: thr, ignitionAge: age > 0 ? age : -1 };
            const tl = Math.max(0, t - tLift);
            // a = g (1.3 / (1 - 0.0036 t) - 1): the mass falls by 0.36 % per second.
            const z = tl > 0 ? 9.81 * ((1.3 / 0.0036) * (tl + (1 / 0.0036 - tl) * Math.log(1 - 0.0036 * tl)) - 0.5 * tl * tl) : 0;
            const vz = tl > 0 ? 9.81 * (-(1.3 / 0.0036) * Math.log(1 - 0.0036 * tl) - tl) : 0;
            v.enu = { x: 0, y: 0, z: z0 + z };
            v.velEnu = { x: 0, y: 0, z: vz };
            const air = labAtmosphere(s.site.alt + z);
            v.aero = { ...stillAir(air.pressure, air.density, air.temperature), q: 0.5 * air.density * vz * vz, mach: vz / 340 };
            v.situation = tl > 0 ? 'flying' : 'prelaunch';
            s.setEngines(v, boosterDef, burning ? last : { throttle: 0, shutdownAge: 60 });
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
            controls: {
              engines: (on: number) => {
                burning = on > 0;
                sim.setEngines(v, boosterDef, burning ? last : { throttle: 0, shutdownAge: 60 });
              },
            },
            camera: { target: { x: 0, y: 0, z: num(q, 'tz', 62) }, yawDeg: num(q, 'yaw', 152), pitchDeg: num(q, 'pitch', 1.5), distance: num(q, 'dist', 430), fovDeg: num(q, 'fov', 38) },
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

function sceneExtra(name: string, q: URLSearchParams, defs: DefLibrary, h: SceneHelpers): SceneDef {
  const earth = h.earth;
  const moonSite: LabSite = { bodyId: h.moon, latDeg: 0.6615, lonDeg: 23.436, alt: 0 };
  const ocean: LabSite = { bodyId: earth.bodyId, latDeg: 5, lonDeg: -140, alt: 0 };
  const partIndex = (parts: PartSnapshot[], type: string, nth = 0): { id: string; index: number } => {
    let seen = 0;
    for (const p of parts) {
      const def = defs.parts[p.def]!;
      for (let i = 0; i < def.modules.length; i++) {
        if (def.modules[i]!.type === type) {
          if (seen === nth) return { id: p.instanceId, index: i };
          seen++;
        }
      }
    }
    throw new Error(`vfx lab: no module of type ${type}`);
  };

  switch (name) {
    // ------------------------------------------------------------------------------------- lunar
    // The lander hovering ?h metres (pads above the ground) over the Moon on its descent engine at ?throttle.
    case 'lunar': {
      return {
        site: moonSite,
        sunElevationDeg: q.get('night') === '1' ? -20 : num(q, 'sun', 12),
        ground: 'regolith',
        build(sim) {
          const { parts } = h.stack(6);
          const ext = h.yExtent(parts);
          const lowest = Math.min(ext.yMin, -8.6);
          const hover = num(q, 'h', 30);
          const rate = num(q, 'descend', 0);
          const throttle = num(q, 'throttle', 0.3);
          const v = sim.addVessel({ id: 'lander', parts, enu: { x: 0, y: 0, z: hover - lowest }, velEnu: { x: 0, y: 0, z: -rate }, qVesToEnu: noseUp(90), boundingRadius: 12 });
          const legs = partIndex(parts, 'legs');
          sim.setModule(v, legs.id, legs.index, { deploy: 1 });
          const script: LabScript = (s) => {
            const height = Math.max(0, v.enu.z + lowest);
            if (height <= 0) {
              v.velEnu = v3.zero();
              v.situation = 'landed';
            }
            s.setEngines(v, 'lyra-d', { throttle: height > 0 ? throttle : 0, shutdownAge: height > 0 ? -1 : 1 });
            s.throttle = throttle;
            s.radarAltitude = height;
          };
          script(sim, 0, 0);
          return {
            script,
            camera: { follow: 'lander', target: { x: 0, y: 0, z: lowest * 0.7 }, yawDeg: num(q, 'yaw', 160), pitchDeg: num(q, 'pitch', 6), distance: num(q, 'dist', 62), fovDeg: num(q, 'fov', 50) },
          };
        },
      };
    }

    // ------------------------------------------------------------------------------------ vacuum
    // Second-stage ignition in vacuum: ullage motors at 0.5 s, six engines light at 2.3 s (lab time).
    case 'vacuum': {
      const alt = num(q, 'altkm', 200) * 1000;
      return {
        site: { bodyId: earth.bodyId, latDeg: earth.latDeg, lonDeg: earth.lonDeg, alt },
        sunElevationDeg: num(q, 'sun', 40),
        ground: 'land',
        build(sim) {
          const fired = num(q, 'fired', 2);
          const { parts } = h.stack(fired);
          const air = labAtmosphere(alt);
          const v = sim.addVessel({ id: 'stack', parts, qVesToEnu: noseAlong({ x: 1, y: 0, z: 0.15 }), aero: stillAir(alt > 140e3 ? 0 : air.pressure, air.density, air.temperature), boundingRadius: 60 });
          const main = fired >= 4 ? 'vela-2v' : 'vela-2';
          const hasUllage = parts.some((p) => p.def === 'meridian-m2-ullage-motors');
          const tIgnite = num(q, 'ignite', 2.3);
          sim.freeFall = 9.2;
          let lit = false;
          const script: LabScript = (s, t) => {
            if (hasUllage) s.setEngines(v, 'meridian-m2-ullage-motors', { throttle: t > 0.5 && t < 4.5 ? 1 : 0, ignitionAge: t > 0.5 ? t - 0.5 : -1, shutdownAge: t >= 4.5 ? t - 4.5 : -1 });
            const age = t - tIgnite;
            const thr = age > 0 ? 1 - Math.exp(-age / 0.8) : 0;
            s.setEngines(v, main, { throttle: thr, ignitionAge: age > 0 ? age : -1 });
            s.throttle = age > 0 ? 1 : 0;
            if (age > 0 && !lit) {
              lit = true;
              for (const e of s.engines(v, main)) s.emit({ type: 'engineIgnition', ut: s.ut, vesselId: v.id, partId: e.part.instanceId });
            }
          };
          script(sim, 0, 0);
          return {
            script,
            camera: { follow: 'stack', target: { x: -52, y: 0, z: -8 }, yawDeg: num(q, 'yaw', 215), pitchDeg: num(q, 'pitch', 12), distance: num(q, 'dist', 95), fovDeg: num(q, 'fov', 50) },
          };
        },
      };
    }

    // --------------------------------------------------------------------------------------- rcs
    // The lander stack in vacuum with its RCS firing: thruster groups alternate every 0.6 s.
    case 'rcs': {
      return {
        site: { bodyId: earth.bodyId, latDeg: earth.latDeg, lonDeg: earth.lonDeg, alt: 250e3 },
        sunElevationDeg: num(q, 'sun', 35),
        ground: 'land',
        build(sim) {
          const { parts } = h.stack(6);
          const v = sim.addVessel({ id: 'lander', parts, qVesToEnu: noseAlong({ x: 0.3, y: 1, z: 0.2 }), boundingRadius: 12 });
          const rcsParts = parts.filter((p) => defs.parts[p.def]!.modules.some((m) => m.type === 'rcs'));
          sim.freeFall = 9.1;
          const script: LabScript = (s, t) => {
            const phase = Math.floor(t / 0.6);
            for (const p of rcsParts) {
              const def = defs.parts[p.def]!;
              def.modules.forEach((m, i) => {
                if (m.type !== 'rcs') return;
                const levels = m.thrusters.map((_, k) => ((k + phase) % 4 === 0 ? 1 : (k + phase) % 4 === 1 ? 0.4 : 0));
                s.setModule(v, p.instanceId, i, { enabled: true, levels: q.get('all') === '1' ? levels.map(() => 1) : levels });
              });
            }
          };
          script(sim, 0, 0);
          return { script, camera: { follow: 'lander', target: { x: 0, y: -3, z: 0 }, yawDeg: num(q, 'yaw', 200), pitchDeg: num(q, 'pitch', 15), distance: num(q, 'dist', 26), fovDeg: num(q, 'fov', 50) } };
        },
      };
    }

    // ----------------------------------------------------------------------------------- staging
    // First-stage separation at 74 km: shutdown at 0.5 s, ullage at 2.2 s, retro motors and decoupling at
    // 2.5 s, second-stage ignition at 4.0 s (lab time).
    case 'staging': {
      const alt = num(q, 'altkm', 74) * 1000;
      return {
        site: { bodyId: earth.bodyId, latDeg: earth.latDeg, lonDeg: earth.lonDeg, alt },
        sunElevationDeg: num(q, 'sun', 38),
        ground: 'land',
        build(sim) {
          const base = h.stack(1);
          const air = labAtmosphere(alt);
          const aero = stillAir(air.pressure, air.density, air.temperature);
          const dir = v3.normalize({ x: 1, y: 0, z: 0.45 });
          const q0 = noseAlong(dir, { x: 0, y: 0, z: 1 });
          const v = sim.addVessel({ id: base.vessel.id, parts: base.parts, qVesToEnu: q0, aero, boundingRadius: 110 });
          const t0 = 0.5;
          sim.freeFall = 9.58;
          let split = false;
          let lit = false;
          let lower: LabVessel | null = null;
          const script: LabScript = (s, t, dt) => {
            const age = t - t0;
            const top = split ? s.vessel(base.vessel.id) : v;
            if (!split) {
              const thr = age < 0 ? 1 : Math.exp(-age / 0.4);
              s.setEngines(v, 'atlas-9m', { throttle: thr < 0.01 ? 0 : thr, shutdownAge: thr < 0.01 ? age - 1.84 : -1 });
            }
            if (age >= 1.7) s.setEngines(top, 'meridian-m2-ullage-motors', { throttle: age < 5.7 ? 1 : 0, ignitionAge: age - 1.7, shutdownAge: age >= 5.7 ? age - 5.7 : -1 });
            if (age >= 2.0 && !split) {
              split = true;
              const r = h.split(base.vessel, 1);
              const idx = s.vessels.indexOf(v);
              const upper = { ...v, parts: vesselPartSnapshots(r.vessel) };
              // Keep the module states the lab has set on parts that stay (ullage motors burning).
              for (const p of upper.parts) {
                const old = v.parts.find((x) => x.instanceId === p.instanceId);
                if (old) p.modules = old.modules;
              }
              s.vessels[idx] = upper;
              const sp = r.spawned[0]!;
              const lowerParts = vesselPartSnapshots(sp);
              for (const p of lowerParts) {
                const old = v.parts.find((x) => x.instanceId === p.instanceId);
                if (old) p.modules = old.modules;
              }
              lower = s.addVessel({
                id: sp.id,
                parts: lowerParts,
                enu: v3.add(v.enu, quat.rotate(q0, sp.r)),
                velEnu: v3.clone(v.velEnu),
                qVesToEnu: quat.mul(q0, sp.q),
                aero,
                boundingRadius: 60,
                controllable: false,
              });
              s.emit({ type: 'decoupled', ut: s.ut, vesselId: base.vessel.id, partId: 'interstage-1', newVesselIds: [sp.id] });
              s.emit({ type: 'stageFired', ut: s.ut, vesselId: base.vessel.id, stageIndex: 1, label: 'M-1 separation' });
            }
            if (lower) {
              const burn = age - 2.0;
              s.setEngines(lower, 'meridian-m1-retro-motors', { throttle: burn < 0.7 ? 1 : 0, ignitionAge: burn, shutdownAge: burn >= 0.7 ? burn - 0.7 : -1 });
              s.setEngines(lower, 'atlas-9m', { throttle: 0, shutdownAge: age - 1.84 });
              // Retro motors slow the spent stage, ullage motors nudge the upper stack on.
              if (burn < 0.7) lower.velEnu = v3.addScaled(lower.velEnu, dir, -7.5 * dt);
              if (age < 5.7) top.velEnu = v3.addScaled(top.velEnu, dir, 0.47 * dt);
              lower.w = { x: 0.012, y: 0, z: 0.004 };
            }
            const ig = age - 3.5;
            if (ig > 0) {
              s.setEngines(top, 'vela-2', { throttle: 1 - Math.exp(-ig / 0.8), ignitionAge: ig });
              top.velEnu = v3.addScaled(top.velEnu, dir, 7.8 * (1 - Math.exp(-ig / 0.8)) * dt);
              if (!lit) {
                lit = true;
                for (const e of s.engines(top, 'vela-2')) s.emit({ type: 'engineIgnition', ut: s.ut, vesselId: top.id, partId: e.part.instanceId });
              }
            }
            s.throttle = ig > 0 || age < 0 ? 1 : 0;
          };
          script(sim, 0, 0);
          return {
            script,
            camera: { follow: base.vessel.id, target: { x: -52, y: 0, z: -24 }, yawDeg: num(q, 'yaw', 205), pitchDeg: num(q, 'pitch', 6), distance: num(q, 'dist', 130), fovDeg: num(q, 'fov', 50) },
          };
        },
      };
    }

    // ----------------------------------------------------------------------------------- reentry
    // The capsule alone at ?altkm (70) and ?speed (7600 m/s; 10900 = lunar return), ?plasma = plasmaIntensity.
    // ?far=1: the camera stands 50 km away.
    case 'reentry': {
      const alt = num(q, 'altkm', 70) * 1000;
      return {
        site: { bodyId: earth.bodyId, latDeg: ocean.latDeg, lonDeg: ocean.lonDeg, alt },
        sunElevationDeg: q.get('night') === '1' ? -30 : num(q, 'sun', 30),
        ground: 'water',
        build(sim) {
          const { parts } = h.stack(8);
          const speed = num(q, 'speed', 7600);
          const plasma = num(q, 'plasma', 1);
          const gamma = num(q, 'fpa', 4) * DEG;
          const dir = { x: Math.cos(gamma), y: 0, z: -Math.sin(gamma) };
          const air = labAtmosphere(alt);
          // Heat shield first, trimmed 19 degrees nose-up of the retrograde direction.
          const trim = 19 * DEG;
          const nose = v3.normalize({ x: -Math.cos(gamma + trim), y: 0, z: Math.sin(gamma + trim) });
          const v = sim.addVessel({
            id: 'capsule',
            parts,
            velEnu: v3.scale(dir, speed),
            qVesToEnu: noseAlong(nose, { x: 0, y: 0, z: 1 }),
            aero: { ...stillAir(air.pressure, air.density, air.temperature), q: 0.5 * air.density * speed * speed, mach: speed / 300, aoa: trim, heatFlux: plasma * 3.0e6, plasmaIntensity: plasma },
            boundingRadius: 3,
          });
          const far = q.get('far') === '1';
          return {
            controls: {
              plasma: (p: number) => {
                v.aero = { ...v.aero, plasmaIntensity: p, heatFlux: p * 3.0e6 };
              },
            },
            camera: far
              ? { follow: 'capsule', target: { x: -30000, y: 0, z: 2000 }, yawDeg: num(q, 'yaw', 180), pitchDeg: num(q, 'pitch', -4), distance: 50000, fovDeg: num(q, 'fov', 40) }
              : { follow: 'capsule', target: { x: -6, y: 0, z: 0.5 }, yawDeg: num(q, 'yaw', 150), pitchDeg: num(q, 'pitch', 12), distance: num(q, 'dist', 22), fovDeg: num(q, 'fov', 50) },
          };
        },
      };
    }

    // ------------------------------------------------------------------------------------ chutes
    // The capsule under ?chute=drogue|main with drag-area fraction ?inflation (and ?state), over the ocean.
    case 'chutes': {
      return {
        site: { ...ocean, alt: num(q, 'alt', 2500) },
        sunElevationDeg: num(q, 'sun', 38),
        ground: 'water',
        build(sim) {
          const { parts } = h.stack(9);
          const mode = q.get('chute') === 'drogue' ? 'drogue' : 'main';
          const air = labAtmosphere(num(q, 'alt', 2500));
          const sink = mode === 'main' ? 8 : 44;
          const v = sim.addVessel({ id: 'capsule', parts, velEnu: { x: 0, y: 0, z: -sink }, qVesToEnu: noseUp(90), aero: { ...stillAir(air.pressure, air.density, air.temperature), q: 0.5 * air.density * sink * sink }, boundingRadius: 3 });
          const drogue = partIndex(parts, 'parachute', 0);
          const main = partIndex(parts, 'parachute', 1);
          const set = (inflation: number, state: string): void => {
            const on = { state, inflation, deployAge: 5, envelope: 'safe', lineDir: { x: 0, y: 1, z: 0 } };
            const off = { state: mode === 'main' ? 'cut' : 'stowed', inflation: 0, deployAge: -1, envelope: 'safe', lineDir: { x: 0, y: 1, z: 0 } };
            sim.setModule(v, drogue.id, drogue.index, mode === 'drogue' ? on : { ...off, state: 'cut' });
            sim.setModule(v, main.id, main.index, mode === 'main' ? on : { ...off, state: 'stowed' });
          };
          const inflation = num(q, 'inflation', 1);
          set(inflation, q.get('state') ?? (inflation >= 1 ? 'full' : 'reefed'));
          return {
            controls: {
              inflation: (x: number) => set(x, x >= 1 ? 'full' : 'reefed'),
              cut: () => {
                set(0, 'cut');
                sim.emit({ type: 'chuteCut', ut: sim.ut, vesselId: v.id, partId: v.parts[0]!.instanceId });
              },
              fail: () => {
                set(0, 'failed');
                sim.emit({ type: 'chuteFailed', ut: sim.ut, vesselId: v.id, partId: v.parts[0]!.instanceId });
              },
            },
            camera:
              mode === 'main'
                ? { follow: 'capsule', target: { x: 0, y: 0, z: 34 }, yawDeg: num(q, 'yaw', 200), pitchDeg: num(q, 'pitch', -12), distance: num(q, 'dist', 96), fovDeg: num(q, 'fov', 50) }
                : { follow: 'capsule', target: { x: 0, y: 0, z: 14 }, yawDeg: num(q, 'yaw', 200), pitchDeg: num(q, 'pitch', -8), distance: num(q, 'dist', 42), fovDeg: num(q, 'fov', 50) },
          };
        },
      };
    }

    // ------------------------------------------------------------------------------------ splash
    // The capsule under three full mains, ?h metres above the sea (default 16): splash at 7.9 m/s, then it floats.
    case 'splash': {
      return {
        site: ocean,
        sunElevationDeg: num(q, 'sun', 36),
        ground: 'water',
        build(sim) {
          const { parts } = h.stack(10);
          const ext = h.yExtent(parts);
          const speed = num(q, 'speed', 7.9);
          const v = sim.addVessel({ id: 'capsule', parts, enu: { x: 0, y: 0, z: num(q, 'h', 16) - ext.yMin }, velEnu: { x: 0, y: 0, z: -speed }, qVesToEnu: noseUp(90), aero: stillAir(101325, 1.2, 290), boundingRadius: 3 });
          const main = partIndex(parts, 'parachute', 1);
          const drogue = partIndex(parts, 'parachute', 0);
          sim.setModule(v, drogue.id, drogue.index, { state: 'cut', inflation: 0 });
          sim.setModule(v, main.id, main.index, { state: 'full', inflation: 1, deployAge: 30, lineDir: { x: 0, y: 1, z: 0 } });
          let tSplash = -1;
          let cut = false;
          const script: LabScript = (s, t) => {
            const bottom = v.enu.z + ext.yMin;
            if (tSplash < 0 && bottom <= 0) {
              tSplash = t;
              s.emit({ type: 'splash', ut: s.ut, vesselId: v.id, speed });
              s.emit({ type: 'touchdown', ut: s.ut, vesselId: v.id, speed, surface: 'water', partId: v.parts[0]!.instanceId });
            }
            if (tSplash >= 0) {
              const age = t - tSplash;
              // Plunge and bob: a damped oscillation about the floating line (0.9 m of draught).
              const zFloat = -ext.yMin - 0.9;
              v.velEnu = v3.zero();
              v.enu = { x: 0, y: 0, z: zFloat - 0.9 * Math.exp(-age / 1.3) * Math.cos(age * 2.4) };
              v.situation = 'splashed';
              v.waterSubmersion = 0.45;
              if (age > 3 && !cut) {
                cut = true;
                s.setModule(v, main.id, main.index, { state: 'cut', inflation: 0 });
                s.emit({ type: 'chuteCut', ut: s.ut, vesselId: v.id, partId: v.parts[0]!.instanceId });
              }
            }
            s.radarAltitude = Math.max(0, bottom);
          };
          script(sim, 0, 0);
          return { script, camera: { target: { x: 0, y: 0, z: num(q, 'tz', 3) }, yawDeg: num(q, 'yaw', 205), pitchDeg: num(q, 'pitch', 7), distance: num(q, 'dist', 38), fovDeg: num(q, 'fov', 50) } };
        },
      };
    }

    // --------------------------------------------------------------------------------- explosion
    // The first stage ?alt metres up (default 600) blows up at 1 s (lab time) with ?energy joules.
    case 'explosion': {
      const pad = q.get('pad') !== '0';
      return {
        site: { bodyId: earth.bodyId, latDeg: earth.latDeg, lonDeg: earth.lonDeg, alt: earth.padElevation },
        sunElevationDeg: q.get('night') === '1' ? -25 : num(q, 'sun', 30),
        ground: 'land',
        pad: pad ? { radius: earth.padRadius, mountHeight: earth.clampHeight, trenchHeadingDeg: earth.trenchHeadingDeg } : null,
        build(sim) {
          const { parts } = h.stack(1);
          const z = num(q, 'alt', 600);
          const energy = num(q, 'energy', 2.0e12);
          const v = sim.addVessel({ id: 'stack', parts, enu: { x: 0, y: 0, z }, velEnu: { x: 0, y: 0, z: 60 }, qVesToEnu: noseUp(90), aero: stillAir(95000, 1.15, 285), boundingRadius: 110 });
          let done = false;
          const script: LabScript = (s, t) => {
            if (!done) s.setEngines(v, 'atlas-9m', { throttle: 1 });
            if (t >= 1 && !done) {
              done = true;
              const centre = v3.add(v.enu, { x: 0, y: 0, z: -75 });
              s.emit({ type: 'explosion', ut: s.ut, vesselId: v.id, posRoot: s.enuToRoot(centre), energy });
              for (const p of v.parts.slice(0, 12)) s.emit({ type: 'partDestroyed', ut: s.ut, vesselId: v.id, partId: p.instanceId, cause: 'explosion', posVes: p.localPos });
              v.parts = v.parts.filter((p) => defs.parts[p.def]!.category === 'command');
              v.velEnu = { x: 3, y: 0, z: 45 };
            }
            s.throttle = done ? 0 : 1;
          };
          script(sim, 0, 0);
          return { script, camera: { target: { x: 0, y: 0, z: z - 60 }, yawDeg: num(q, 'yaw', 160), pitchDeg: num(q, 'pitch', -8), distance: num(q, 'dist', 900), fovDeg: num(q, 'fov', 45) } };
        },
      };
    }

    default:
      throw new Error(`vfx lab: unknown scene "${name}"`);
  }
}

export type { LabVessel };
