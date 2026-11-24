/**
 * What the milestone evaluator is told about the pilot's flight (src/sim/world/milestones.ts,
 * `MilestoneHost`): the standard numbers of a record, the touchdown numbers, the peaks and the separation
 * bookkeeping. Read-only over the vessel: nothing here moves anything. (The objective observer of
 * `src/universe` takes this over with the milestones; MIGRATION_V2 section 5.)
 */
import type { SurfaceTarget } from '@/core/contracts/sim';
import type { VesselEnvironment } from '@/core/contracts/simInternal';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { quat } from '@/core/math/quat';
import { RAD } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import type { BodyFrames } from '../island/frames';
import { greatCircle, targetDirection } from '../nav/landingTarget';
import { computeOrbitalReadouts } from '../nav/readouts';
import { chuteEnvelope, helmCraft, radarAltitude, reportedMach, vesselReadouts, type Vessel } from '../vessel';

interface TouchState {
  verticalSpeed: number;
  horizontalSpeed: number;
  tilt: number;
}

export class FlightRecord {
  peakG = 0;
  peakGDose = 0;
  private wasTouching = false;
  private preContact: TouchState = { verticalSpeed: 0, horizontalSpeed: 0, tilt: 0 };
  private touchdown: TouchState = { verticalSpeed: 0, horizontalSpeed: 0, tilt: 0 };
  readonly stageFiredUt = new Map<number, number>();
  readonly separations: number[] = [];

  constructor(
    private readonly frames: BodyFrames,
    private readonly terrain: TerrainProvider,
    private readonly surfaceTargets: readonly SurfaceTarget[],
  ) {}

  /** After an advance of `dt` seconds (0 = a rails advance): the peaks and the state just before first contact. Returns whether the vessel touches. */
  observe(v: Vessel, bodyId: string, dt: number): boolean {
    const base = this.frames.base(bodyId);
    const rl = v3.len(v.r);
    if (v.gLoad > this.peakG && v.hold === null) this.peakG = v.gLoad;
    if (v.gDose > this.peakGDose) this.peakGDose = v.gDose;
    // surface-relative velocity for the touchdown capture
    const up = v3.scale(v.r, 1 / rl);
    const sp = base.info.spin;
    const gx = v.v.x - (sp.y * v.r.z - sp.z * v.r.y);
    const gy = v.v.y - (sp.z * v.r.x - sp.x * v.r.z);
    const gz = v.v.z - (sp.x * v.r.y - sp.y * v.r.x);
    const vz = gx * up.x + gy * up.y + gz * up.z;
    const touching = v.contact.anyContact || v.contact.waterSubmersion > 0;
    if (dt > 0) {
      if (!touching) {
        if (v.groundClearance < 200) {
          this.preContact.verticalSpeed = vz;
          this.preContact.horizontalSpeed = Math.hypot(gx - vz * up.x, gy - vz * up.y, gz - vz * up.z);
          this.preContact.tilt = v3.angle(quat.rotate(v.q, { x: 0, y: 1, z: 0 }), up);
        }
      } else if (!this.wasTouching && v.hold === null) {
        this.touchdown = { ...this.preContact };
      }
      this.wasTouching = touching;
    }
    return touching;
  }

  separatedSince(stageIndex: number): number {
    const t = this.stageFiredUt.get(stageIndex);
    if (t === undefined) return 0;
    let n = 0;
    for (const s of this.separations) if (s >= t - 1e-9) n++;
    return n;
  }

  chuteDeployData(v: Vessel, bodyId: string, mode: 'drogue' | 'main'): Record<string, number> {
    const base = this.frames.base(bodyId);
    const altitude = v3.len(v.r) - base.info.radius - base.seaLevel;
    const speed = v3.len(v.aero.airVelocity);
    let worst = 0;
    for (const p of v.parts) {
      for (const md of p.def.modules) {
        if (md.type !== 'parachute' || md.mode !== mode) continue;
        const env = chuteEnvelope(md, altitude, v.aero.mach, speed, v.aero.q);
        worst = Math.max(worst, env === 'safe' ? 0 : env === 'risky' ? 1 : 2);
      }
    }
    return { chuteEnvelope: worst, deployAltitude: altitude, deployMach: reportedMach(v), deploySpeed: speed, deployDynamicPressure: v.aero.q };
  }

  standardData(v: Vessel, bodyId: string, env: VesselEnvironment, com: { r: Vec3; v: Vec3 }, ut: number, extra: { liftoffUt: number | null; incompleteQueries: number; terrainWarpClamps: number; vesselCount: number }): Record<string, number> {
    const base = this.frames.base(bodyId);
    const o = computeOrbitalReadouts({ system: this.frames.system, bodyId, r: com.r, v: com.v, ut });
    const vr = vesselReadouts(v, env);
    const data: Record<string, number> = {
      ut,
      met: extra.liftoffUt === null ? 0 : ut - extra.liftoffUt,
      altitude: o.altitudeAsl,
      radarAltitude: radarAltitude(v, env),
      latitudeDeg: o.latitude * RAD,
      longitudeDeg: o.longitude * RAD,
      speedOrbital: o.speedOrbital,
      speedSurface: o.speedSurface,
      verticalSpeed: o.verticalSpeed,
      horizontalSpeed: o.horizontalSpeed,
      mass: v.mp.mass,
      gLoad: vr.gLoad,
      peakG: this.peakG,
      gDose: v.gDose,
      peakGDose: this.peakGDose,
      ablatorFraction: vr.ablatorFraction ?? -1,
      rcsFraction: vr.rcsFraction ?? -1,
      maxTempFraction: vr.maxTempFraction,
      deltaVRemaining: vr.deltaVTotal,
      stagesFired: helmCraft(v).nextStage,
      incompleteQueries: extra.incompleteQueries,
      terrainWarpClamps: extra.terrainWarpClamps,
      vesselCount: extra.vesselCount,
      surfaceGravity: base.surfaceGravity,
    };
    // Remaining propellant per stage group (engine propellants only).
    const excluded = new Set<string>();
    for (const p of v.parts) {
      for (const md of p.def.modules) {
        if (md.type === 'rcs') excluded.add(md.resource);
        if (md.type === 'heatShield') excluded.add(md.ablatorResource);
      }
    }
    const kg = new Map<string, number>();
    const cap = new Map<string, number>();
    for (const p of v.parts) {
      const res = p.def.resources ?? [];
      for (let k = 0; k < res.length; k++) {
        if (excluded.has(res[k]!.resource)) continue;
        kg.set(p.stageGroup, (kg.get(p.stageGroup) ?? 0) + p.resources[k]!);
        cap.set(p.stageGroup, (cap.get(p.stageGroup) ?? 0) + res[k]!.capacity);
      }
    }
    for (const [group, amount] of kg) {
      data[`propellantKg:${group}`] = amount;
      const c = cap.get(group)!;
      data[`propellantFraction:${group}`] = c > 0 ? amount / c : 0;
    }
    return data;
  }

  touchdownData(v: Vessel, bodyId: string, env: VesselEnvironment): Record<string, number> {
    const body = this.frames.info(bodyId);
    const up = v3.normalize(v.r);
    const dirFixed = quat.rotateInv(env.qFixedToInertial, up);
    let broken = 0;
    let legs = 0;
    for (const p of v.parts) {
      for (const m of p.modules) {
        if (m.type !== 'legs') continue;
        legs += m.broken.length;
        for (const b of m.broken) if (b) broken++;
      }
    }
    let landingDistance = -1;
    let zoneDistance = -1;
    let zoneRadius = -1;
    for (const t of this.surfaceTargets) {
      if (t.bodyId !== bodyId) continue;
      const d = greatCircle(dirFixed, targetDirection(t)).angle * body.radius;
      if (t.kind === 'landing' && (landingDistance < 0 || d < landingDistance)) landingDistance = d;
      // The nearest zone is the one whose edge is closest (inside counts as negative distance to the edge).
      if (t.kind === 'recovery' && (zoneDistance < 0 || d - t.radius < zoneDistance - zoneRadius)) {
        zoneDistance = d;
        zoneRadius = t.radius;
      }
    }
    const hasTerrain = this.frames.base(bodyId).hasTerrain;
    const res = hasTerrain ? this.terrain.residency(bodyId, dirFixed) : { residentLevel: 0, availableLevel: 0, effectiveLevel: 0, complete: true };
    const water = v.contact.waterSubmersion > 0 || v.surface === 'splashed' || (hasTerrain && env.surfaceKind(dirFixed) === 'water');
    return {
      touchdownVerticalSpeed: Math.abs(Math.min(0, this.touchdown.verticalSpeed)),
      touchdownHorizontalSpeed: this.touchdown.horizontalSpeed,
      touchdownTiltDeg: this.touchdown.tilt * RAD,
      tiltDeg: v3.angle(quat.rotate(v.q, { x: 0, y: 1, z: 0 }), up) * RAD,
      legs,
      legsBroken: broken,
      legsIntact: legs > 0 && broken === 0 ? 1 : 0,
      distanceToLandingTarget: landingDistance,
      residentLevel: res.residentLevel,
      availableLevel: res.availableLevel,
      effectiveLevel: res.effectiveLevel,
      terrainComplete: res.complete ? 1 : 0,
      surfaceWater: water ? 1 : 0,
      recoveryZoneDistance: zoneDistance,
      recoveryZoneRadius: zoneRadius,
      insideRecoveryZone: zoneDistance >= 0 && zoneDistance < zoneRadius ? 1 : 0,
      crewAlive: v.crewAlive ? 1 : 0,
    };
  }
}
