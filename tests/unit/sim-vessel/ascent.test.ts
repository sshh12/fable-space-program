/**
 * Integration: the whole stack flown from the pad through M-1 burnout, staging, and tower + fairing
 * jettison with the pitch programme of sim-design 16.2 (phases 1-3) on SAS direction hold. Checks that
 * the vehicle data, aerodynamics, heating and structural limits make a normal ascent survivable:
 * max-q, q-alpha margin, g-load, skin temperatures, staging state.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimEvent } from '@/core/contracts/sim';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';
import { assembleVessel, fireNextStage, setSasEnabled, setSasHoldDirection, setSasMode, stepVessel, vesselReadouts, type Vessel } from '@/sim/vessel';
import { controls, DT, isFiniteVessel, loadLibrary, makeEnv, placeUpright, STANDARD_DENSITY, VEHICLE } from './helpers';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadLibrary();
});

describe('ascent', () => {
  it('pad to M-2 flight with tower and fairing jettison', () => {
    const env = makeEnv({ densityTable: STANDARD_DENSITY, heating: defs.bodies['earth']!.atmosphere!.heating });
    const v = assembleVessel(defs, VEHICLE);
    placeUpright(v, env, 120);
    const vessels: Vessel[] = [v];
    const events: SimEvent[] = [];
    const c = controls({ throttle: 1 });
    setSasEnabled(v, true);
    setSasMode(v, 'prograde');
    const pad = v3.clone(v.r);
    const east = { x: 1, y: 0, z: 0 };
    let t = 0;
    let maxQ = 0;
    let maxQAlt = 0;
    let maxQAlpha = 0;
    let maxG = 0;
    let maxTemp = 0;
    let liftoff = -1;
    let burnout = -1;
    let burnoutAlt = 0;
    let burnoutSpeed = 0;
    let jettisonAlt = 0;
    let hottest = '';
    const press = (): void => {
      const res = fireNextStage(v, env);
      expect(res.ok).toBe(true);
      events.push(...res.events);
      vessels.push(...res.spawned);
    };
    press();
    while (t < 330) {
      const up = v3.normalize(v.r);
      const altitude = v3.len(v.r) - v3.len(pad);
      // Pitch programme: vertical to 800 m, then theta(h) above the local horizon, heading east.
      let pitch = 90;
      if (altitude > 800) pitch = Math.max(22, 90 - 68 * Math.pow((altitude - 800) / 65000, 0.6));
      const horizon = v3.normalize(v3.reject(east, up));
      const target = v3.add(v3.scale(up, Math.sin(pitch * DEG)), v3.scale(horizon, Math.cos(pitch * DEG)));
      setSasHoldDirection(v, target);
      for (let k = 0; k < vessels.length; k++) {
        const x = vessels[k]!;
        if (x.destroyed) continue;
        const res = stepVessel(x, env, k === 0 ? c : controls(), DT);
        events.push(...res.events);
        vessels.push(...res.spawned);
      }
      env.advance(DT);
      t += DT;
      if (liftoff < 0 && v.hold === null) liftoff = t;
      if (v.aero.q > maxQ) {
        maxQ = v.aero.q;
        maxQAlt = altitude;
      }
      maxQAlpha = Math.max(maxQAlpha, v.aero.q * v.aero.aoa);
      maxG = Math.max(maxG, v.gLoad);
      // M-1 burnout: stage.
      if (burnout < 0 && v.crafts[0]!.nextStage === 1 && liftoff > 0 && v.thrust < 1e6 && t - liftoff > 100) {
        burnout = t - liftoff;
        burnoutAlt = altitude;
        burnoutSpeed = v3.len(v.v);
        press();
      }
      if (v.crafts[0]!.nextStage === 2 && altitude > 96000) {
        jettisonAlt = altitude;
        maxTemp = vesselReadouts(v, env).maxTempFraction;
        hottest = v.parts
          .map((p) => ({ id: p.instanceId, f: Math.max(...p.temps.map((T, k) => T / p.def.thermal.surfaces[k]!.maxTemp)), T: Math.max(...p.temps) }))
          .sort((a, b) => b.f - a.f)
          .slice(0, 4)
          .map((x) => x.id + ' ' + x.T.toFixed(0) + ' K (' + (x.f * 100).toFixed(0) + ' %)')
          .join(', ');
        press();
      }
    }
    const destroyed = events.filter((e) => e.type === 'partDestroyed' || e.type === 'jointBroken' || e.type === 'crewLost');
    console.log(
      [
        'ascent: lift-off ' + liftoff.toFixed(2) + ' s after ignition, max-q ' + (maxQ / 1000).toFixed(1) + ' kPa at ' + (maxQAlt / 1000).toFixed(1) + ' km, max q-alpha ' + maxQAlpha.toFixed(0) + ' Pa rad, peak ' + maxG.toFixed(2) + ' g',
        '        M-1 burnout ' + burnout.toFixed(1) + ' s after lift-off at ' + (burnoutAlt / 1000).toFixed(1) + ' km, ' + burnoutSpeed.toFixed(0) + ' m/s; tower + fairing jettison at ' + (jettisonAlt / 1000).toFixed(1) + ' km, hottest skin ' + (maxTemp * 100).toFixed(0) + ' % of its limit',
        '        hottest parts at jettison: ' + hottest,
        '        vessels at the end: ' + vessels.length + ', M-2 stack mass ' + v.mp.mass.toFixed(0) + ' kg',
      ].join('\n'),
    );
    expect(destroyed.map((e) => e.type + ':' + ('partId' in e ? e.partId : ''))).toEqual([]);
    expect(liftoff).toBeGreaterThan(2.99);
    expect(liftoff).toBeLessThan(3.1);
    // sim-design 8.2 / 12: max-q 28-31 kPa near 12 km on a nominal ascent (the profile here is fixed, not tuned).
    expect(maxQ).toBeGreaterThan(20000);
    expect(maxQ).toBeLessThan(40000);
    expect(maxQAlpha).toBeLessThan(0.8 * defs.parts['meridian-interstage-2']!.joint.maxQAlpha!);
    expect(maxG).toBeGreaterThan(3.5);
    expect(maxG).toBeLessThan(4.0);
    expect(burnout).toBeGreaterThan(157);
    expect(burnout).toBeLessThan(162);
    expect(burnoutAlt).toBeGreaterThan(55000);
    expect(burnoutAlt).toBeLessThan(85000);
    expect(burnoutSpeed).toBeGreaterThan(1900);
    expect(burnoutSpeed).toBeLessThan(2600);
    expect(maxTemp).toBeLessThan(0.9);
    expect(jettisonAlt).toBeGreaterThan(96000);
    // Clamps, M-1, tower, four petals + the vehicle.
    expect(vessels).toHaveLength(8);
    for (const x of vessels) if (!x.destroyed) expect(isFiniteVessel(x)).toBe(true);
    expect(v.thrust).toBeGreaterThan(6.5e6);
    expect(v.crewAlive).toBe(true);
    // Still pointing where the programme says.
    const nose = quat.rotate(v.q, { x: 0, y: 1, z: 0 });
    expect(v3.angle(nose, v.sas.holdDir!) / DEG).toBeLessThan(1);
  }, 120000);
});
