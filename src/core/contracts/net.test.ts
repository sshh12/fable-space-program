import { describe, expect, it } from 'vitest';
import { PHYSICS_DT, RAILS_WARP_LEVEL_COUNT, WARP_LEVELS, MAX_PHYSICS_WARP_INDEX } from './defs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PAD_CLASS_LIMITS, DEFAULT_UNIVERSE_RULES, TICKS_PER_SECOND, UNIVERSE_RULE_TIMERS, type CensusEntry, type ClockState, type PadClass, type UniverseRules } from './net';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const DAY = 86400;
const YEAR = 365.25 * DAY;

function at(rules: UniverseRules, dotted: string): unknown {
  const [group, field] = dotted.split('.') as [keyof UniverseRules, string];
  return (rules[group] as unknown as Record<string, unknown>)[field];
}

describe('UniverseRules: the default document', () => {
  it('one tick is one physics step', () => {
    expect(TICKS_PER_SECOND * PHYSICS_DT).toBe(1);
    expect(RAILS_WARP_LEVEL_COUNT).toBe(WARP_LEVELS.length - MAX_PHYSICS_WARP_INDEX - 1);
  });

  it('is a plain JSON document: it survives a round trip unchanged', () => {
    const copy = JSON.parse(JSON.stringify(DEFAULT_UNIVERSE_RULES)) as UniverseRules;
    expect(copy).toEqual(DEFAULT_UNIVERSE_RULES);
    const walk = (v: unknown, where: string): void => {
      if (typeof v === 'number') expect(Number.isFinite(v), where).toBe(true);
      else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
    };
    walk(DEFAULT_UNIVERSE_RULES, 'rules');
  });

  it('carries the numbers of ARCHITECTURE 5, 7.4-7.6, 9.4, 15.5 and 26', () => {
    const r = DEFAULT_UNIVERSE_RULES;
    // 5: time model
    expect(r.time.leadCap).toBe(250 * YEAR);
    expect(r.time.advanceGuardBand).toBe(20 * YEAR);
    expect(r.time.advanceLimitDefault).toBe(30 * DAY);
    expect(r.time.advanceLimitStation).toBe(6 * YEAR);
    expect(r.time.physicsWarpMax).toBe(4);
    expect([r.time.launchRangeRadius, r.time.launchRangeAltitude]).toEqual([150_000, 100_000]);
    expect(r.time.targetApproachSteps).toEqual([{ timeBefore: 60, maxRate: 50 }, { timeBefore: 10, maxRate: 1 }]);
    expect([r.time.readyCheckTime, r.time.proposalInterval, r.time.idleTime, r.time.stopWindow, r.time.roundTripAllowance]).toEqual([15, 30, 120, 0.5, 0.25]);
    expect([r.time.jumpArrivalClearance, r.time.jumpArrivalLookahead, r.time.jumpAlternativeLead]).toEqual([50, 30, 10]);
    expect([r.time.encounterLeadTime, r.time.encounterMargin, r.time.departureContactLookahead, r.time.departureNoticeTime]).toEqual([10, 10, 30, 10]);
    expect([r.time.joinCooldown, r.time.joinCooldownAfterFork, r.time.advanceRetryInterval]).toEqual([60, 1800, 300]);
    expect([r.time.resumeWindow, r.time.resumeWindowBuildChange]).toEqual([30, 90]);
    expect([r.time.cohortBucket, r.time.cohortHorizon, r.time.cohortOfferWait]).toEqual([300, 14 * DAY, 60]);
    expect(r.time.forecastMaxPatches).toBe(16);
    expect(r.time.lagCap).toBe(0);
    expect([r.claim.joinDistanceBase, r.claim.joinClosingTime, r.claim.islandPartFactor, r.claim.armedMarginBase, r.claim.armedClosingTime, r.claim.reservationReleaseDelay]).toEqual([1000, 2, 2, 200, 2, 10]);
    expect([r.claim.materialiseReachTime, r.claim.materialiseClearance, r.claim.clearingTime, r.claim.clearingAccelMax, r.claim.clearingTimeout]).toEqual([30, 5, 15, 0.5, 30]);
    expect([r.disconnect.pingInterval, r.disconnect.lossTimeout, r.disconnect.soloLatchTime, r.disconnect.sharedRotationLatch, r.disconnect.sharedThrottleLatch, r.disconnect.reconnectGrace]).toEqual([1, 3, 10, 0.25, 2, 120]);
    // 7.4-7.6
    expect([r.contact.subSteps, r.contact.solverIterations, r.contact.restitution, r.contact.restitutionMinSpeed, r.contact.friction]).toEqual([4, 8, 0.2, 0.3, 0.5]);
    expect([r.contact.nascentClearance, r.contact.hypervelocitySpeed, r.contact.hypervelocitySpecificEnergy, r.contact.explosionImpulsePerKg]).toEqual([0.05, 250, 40_000, 150]);
    expect([r.contact.maxFragmentsPerCollision, r.contact.fragmentMassLimit, r.contact.fragmentLifetime]).toEqual([12, 50, 60]);
    expect([r.docking.hardDockOffset, r.docking.hardDockAngleDeg, r.docking.hardDockSpeed, r.docking.hardDockDwell]).toEqual([0.003, 0.1, 0.003, 0.5]);
    expect([r.docking.softCaptureClampTime, r.docking.linkBreakTime, r.docking.helmRequestTimeout]).toEqual([0.5, 0.2, 30]);
    expect(r.docking.defaultLendPolicy).toEqual({ lendAttitude: true, lendEngines: false, lendPropellant: false, helm: 'crew' });
    expect([r.docking.maxCraftPerAssembly, r.docking.maxPartsPerAssembly, r.docking.islandVesselBudget]).toEqual([32, 600, 64]);
    expect([r.terrain.requestRadarAltitude, r.terrain.requestAltitude, r.terrain.requestSpeed]).toEqual([2000, 50_000, 200]);
    // 9.4
    expect([r.pads.reservationHold, r.pads.maxStay, r.pads.stayExtension, r.pads.maxStayUpTime, r.pads.disconnectGrace]).toEqual([90, 300, 120, 600, 60]);
    expect([r.pads.clearAltitude, r.pads.clearDistance, r.pads.safingTime, r.pads.restRecoveryTime, r.pads.rangeSafetyAltitude]).toEqual([1500, 1000, 20, 60, 5000]);
    expect(r.pads.keepOutRadius).toEqual({ light: 300, medium: 450, heavy: 600 });
    // 15.5
    expect([r.expiry.craftRetention, r.expiry.shipSlots, r.expiry.unownedAssemblyRetention, r.expiry.unownedCraftRetention]).toEqual([14 * DAY, 10, 48 * 3600, 48 * 3600]);
    expect([r.expiry.debrisRetention, r.expiry.debrisPerAccount, r.expiry.unownedPerSoi, r.expiry.wreckRetention]).toEqual([2 * 3600, 24, 5000, 2 * 3600]);
    expect(r.expiry.lostDistance).toBe(100 * 149_597_870_700);
    expect([r.expiry.arcRetention, r.expiry.accountRetention, r.expiry.lobbyObjectCap]).toEqual([24 * 3600, 90 * DAY, 50_000]);
    expect([r.expiry.pressureStart, r.expiry.pressureFloorSingleSession, r.expiry.pressureFloor, r.expiry.sweepInterval, r.expiry.outageExtensionThreshold]).toEqual([0.7, 24 * 3600, 72 * 3600, 60, 3600]);
    // 26
    expect([r.limits.inputsPerSecond, r.limits.commandsPerSecond, r.limits.timeMessages, r.limits.timeMessageWindow]).toEqual([60, 20, 6, 10]);
    // The two bounds section 26 names without a number: the lead's choice.
    expect([r.limits.subscriptionsPerSecond, r.limits.accountsPerAddressPerHour]).toEqual([5, 10]);
    expect(r.contact.defaultCrashTolerance).toBe(6);
    expect(r.planning).toEqual({ workerMaxEstimateMs: 50, weakClientCpuScore: null });
  });

  it('pad class limits: positive finite numbers that rise with the class; heavy is what LC-1 states today', () => {
    const order: PadClass[] = ['light', 'medium', 'heavy'];
    const limits = DEFAULT_UNIVERSE_RULES.pads.classLimits ?? DEFAULT_PAD_CLASS_LIMITS;
    // The field of the default document, once it is one, IS the constant.
    expect(limits).toEqual(DEFAULT_PAD_CLASS_LIMITS);
    expect(Object.keys(limits).sort()).toEqual([...order].sort());
    for (const c of order) {
      for (const v of [limits[c].maxLiftoffMass, limits[c].maxDiameter]) {
        expect(Number.isFinite(v), c).toBe(true);
        expect(v, c).toBeGreaterThan(0);
      }
    }
    for (let i = 1; i < order.length; i++) {
      expect(limits[order[i]!].maxLiftoffMass, order[i]).toBeGreaterThan(limits[order[i - 1]!].maxLiftoffMass);
      expect(limits[order[i]!].maxDiameter, order[i]).toBeGreaterThan(limits[order[i - 1]!].maxDiameter);
    }
    // Provisional (the lead sets them from fleet-data's table): LC-1's 3,000 t and 9.5 m, 8.7 % over the 2,760 t stack.
    expect(limits.heavy).toEqual({ maxLiftoffMass: 3_000_000, maxDiameter: 9.5 });
    expect(limits.heavy.maxLiftoffMass / 2_760_000 - 1).toBeCloseTo(0.087, 3);
    expect(limits.medium).toEqual({ maxLiftoffMass: 700_000, maxDiameter: 7 });
    expect(limits.light).toEqual({ maxLiftoffMass: 70_000, maxDiameter: 2.5 });
    expect(JSON.parse(JSON.stringify(limits))).toEqual(limits);
  });

  it('every timer names one of the three bases, and every named timer is a positive number of the document', () => {
    for (const [key, base] of Object.entries(UNIVERSE_RULE_TIMERS)) {
      expect(['ticks', 'upTime', 'wall'], key).toContain(base);
      const value = at(DEFAULT_UNIVERSE_RULES, key);
      expect(typeof value, key).toBe('number');
      // The commit lag cap is a timer whose default is zero (real time); every other timer is positive.
      if (key !== 'time.lagCap') expect(value as number, key).toBeGreaterThan(0);
    }
    // Expiry runs on the wall clock and only expiry does (ARCHITECTURE U19).
    for (const [key, base] of Object.entries(UNIVERSE_RULE_TIMERS)) expect(base === 'wall', key).toBe(key.startsWith('expiry.'));
    // Pad occupancy and safing, soft capture, port cooldown and the clearing timers are universe ticks.
    for (const key of ['pads.maxStay', 'pads.safingTime', 'docking.softCaptureClampTime', 'docking.portCooldownTime', 'claim.clearingTime', 'claim.clearingTimeout']) expect(UNIVERSE_RULE_TIMERS[key], key).toBe('ticks');
    // Reservation holds, ready-checks, helm requests, the reconnect grace and the resume window are up-time.
    for (const key of ['pads.reservationHold', 'time.readyCheckTime', 'docking.helmRequestTimeout', 'disconnect.reconnectGrace', 'time.resumeWindow']) expect(UNIVERSE_RULE_TIMERS[key], key).toBe('upTime');
    // A tick-based duration is a whole number of ticks.
    for (const [key, base] of Object.entries(UNIVERSE_RULE_TIMERS)) {
      if (base !== 'ticks') continue;
      const ticks = (at(DEFAULT_UNIVERSE_RULES, key) as number) * TICKS_PER_SECOND;
      expect(Math.abs(ticks - Math.round(ticks)), key).toBeLessThan(1e-9);
    }
  });
});

describe('the types of net.ts are JSON: what is written is what is read', () => {
  it('"no such tick" is null, never Infinity, so a clock and a census entry survive the wire', () => {
    const clock: ClockState = { id: 'c1', kind: 'private', tick0: 112_588_898_260, anchorUpMs: 5_000, rate: 1000, untilTick: null, limitedBy: null, members: [], proposals: [] };
    const entry: CensusEntry = {
      vesselId: 'v1', craftIds: ['v1'], kind: 'debris', name: 'stage', vehicleId: 'meridian-lunar', ownerIds: [null], ownerCallsigns: [null], bodyId: 'earth', patches: [], landed: null,
      headTick: 112_588_898_260, horizonTick: null, chainEndTick: 112_589_000_000, clockId: null, reservedBy: null, limitTick: null, radius: 4, expiresWallMs: null, thrusting: false, revision: 3,
    };
    expect(JSON.parse(JSON.stringify(clock))).toEqual(clock);
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
    // What the old encoding did: Infinity does not survive.
    expect(JSON.parse(JSON.stringify({ untilTick: Infinity }))).toEqual({ untilTick: null });
    // A tick is exact in a float64 and in JSON far beyond the lead cap (250 years of ticks from 2030).
    const far = (1_000_000_000 + 250 * 365.25 * 86400) * TICKS_PER_SECOND;
    expect(Number.isSafeInteger(far)).toBe(true);
    expect(JSON.parse(JSON.stringify({ t: far })).t).toBe(far);
  });

  it('data/defs/rules/default.json states nothing that differs from the default document', () => {
    // A rules file is stored as overrides of the default (net.ts, `UniverseRules`), so the `default` file may
    // state every field (the form step 3.6 wrote), a few, or only its id: whatever it states IS the default.
    const file = path.join(repoRoot, 'data', 'defs', 'rules', 'default.json');
    if (!fs.existsSync(file)) {
      console.log('[rules] data/defs/rules/default.json does not exist: nothing to compare');
      return;
    }
    const model = JSON.parse(JSON.stringify(DEFAULT_UNIVERSE_RULES)) as Record<string, unknown>;
    const stated = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(stated['id']).toBe('default');
    const walk = (value: unknown, def: unknown, at: string): void => {
      const plainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
      if (plainObject(value) && plainObject(def)) {
        for (const k of Object.keys(value)) {
          expect(k in def, `${at}${k} is a field of UniverseRules`).toBe(true);
          walk(value[k], def[k], `${at}${k}.`);
        }
      } else {
        expect(value, at.slice(0, -1)).toEqual(def);
      }
    };
    walk(stated, model, '');
  });
});
