/**
 * Staging: the stage stack, the abort sequence, delayed actions and the execution of every StageAction
 * kind (sim-design section 11). Decoupling convention: a `decouple` / `jettisonLES` action names a part
 * with a `decoupler` module; the joint between that part and its PARENT is cut, so the named part stays
 * with its own subtree (interstages stay on the lower stage because the tree is rooted at the capsule).
 */
import type { StageAction, TimedStageAction } from '@/core/contracts/defs';
import type { SimEvent } from '@/core/contracts/sim';
import type { VesselEnvironment } from '@/core/contracts/simInternal';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { computeMassProps, vesselMass } from './massProps';
import { actionParts, applyImpulse, jettisonPanels, mergeVessels, separateVessel } from './split';
import { partPoint, structureOf } from './structure';
import { STAGE_LOCKOUT, type PartRuntime, type StepContext, type Vessel } from './types';

export interface StagingResult {
  ok: boolean;
  /** Why the command was refused (shown in the HUD). */
  reason?: string;
  events: SimEvent[];
  spawned: Vessel[];
}

function findPart(vessel: Vessel, id: string): number {
  for (let i = 0; i < vessel.parts.length; i++) if (vessel.parts[i]!.instanceId === id) return i;
  return -1;
}

function wake(vessel: Vessel): void {
  if (vessel.hold === 'asleep') {
    vessel.hold = null;
    vessel.anchor = null;
    vessel.restTimer = 0;
  }
}

/** Unit vector (BCI) from the decoupler part toward its parent along the decoupler axis. */
function separationAxis(vessel: Vessel, part: PartRuntime, sepY: number): Vec3 {
  const parent = vessel.parts[part.parent]!;
  const axis = quat.rotate(part.rot, { x: 0, y: 1, z: 0 });
  const sep = partPoint(part, [0, sepY, 0]);
  const pb = parent.def.bounds;
  const pc = partPoint(parent, [0, (pb.yMin + pb.yMax) / 2, 0]);
  const sign = v3.dot(v3.sub(pc, sep), axis) >= 0 ? 1 : -1;
  return quat.rotate(vessel.q, v3.scale(axis, sign));
}

/** Cut the joint between part `index` and its parent, pushing the two sides apart with `impulse` N s. */
function decouplePart(vessel: Vessel, index: number, impulse: number, sepY: number, ctx: StepContext): Vessel[] {
  const part = vessel.parts[index]!;
  if (part.parent < 0) return [];
  const id = part.instanceId;
  const n = separationAxis(vessel, part, sepY);
  const held = vessel.hold;
  const created = separateVessel(vessel, [index], [], ctx);
  if (created.length === 0) return created;
  const all = [vessel, ...created];
  const childSide = all.find((v) => v.parts.some((p) => p.instanceId === id))!;
  const parentSide = childSide === vessel ? created[0]! : vessel;
  for (const v of all) fixHold(v, held);
  if (impulse !== 0) {
    if (parentSide.hold === null) applyImpulse(parentSide, n.x * impulse, n.y * impulse, n.z * impulse);
    if (childSide.hold === null) applyImpulse(childSide, -n.x * impulse, -n.y * impulse, -n.z * impulse);
  }
  return created;
}

/** After a split, only the piece that still owns an unreleased launch clamp stays held. */
function fixHold(v: Vessel, previous: Vessel['hold']): void {
  if (previous === 'clamps') {
    const clamped = v.parts.some((p) => p.modules.some((m) => m.type === 'launchClamp' && !m.released));
    v.hold = clamped ? 'clamps' : null;
    v.surface = clamped ? 'prelaunch' : 'none';
    v.anchor = null;
  } else if (previous === 'asleep') {
    v.hold = null;
    v.anchor = null;
    v.restTimer = 0;
  }
}

function currentThrust(vessel: Vessel): number {
  let t = 0;
  for (const p of vessel.parts) for (const m of p.modules) if (m.type === 'engine') t += m.thrust;
  return t;
}

function igniteModules(vessel: Vessel, part: PartRuntime, fixedOnly: boolean, ctx: StepContext): void {
  for (let m = 0; m < part.def.modules.length; m++) {
    const md = part.def.modules[m]!;
    const ms = part.modules[m]!;
    const rt = part.rt[m]!;
    if (md.type === 'engine' && ms.type === 'engine' && rt.type === 'engine') {
      if (fixedOnly && !md.fixedBurn) continue;
      if (md.fixedBurn) {
        if (rt.started) continue;
        rt.started = true;
        if (ctx.instant) {
          // Spent: remove the propellant the burn consumes from the part's own tanks.
          const burn = (md.thrustVac / (md.ispVac * 9.80665)) * md.fixedBurn.duration;
          rt.burnLeft = 0;
          for (const pr of md.propellants) {
            const k = (part.def.resources ?? []).findIndex((r) => r.resource === pr.resource);
            if (k >= 0) {
              const take = Math.min(part.resources[k]!, burn * pr.ratio);
              part.resources[k] = part.resources[k]! - take;
            }
          }
          ms.active = false;
          continue;
        }
      }
      ms.active = true;
    }
  }
  for (const ms of part.modules) {
    if (ms.type === 'les' && !ms.fired && !fixedOnly) {
      ms.fired = true;
      ctx.events.push({ type: 'lesFired', ut: ctx.ut, vesselId: vessel.id, partId: part.instanceId });
    }
  }
}

/** Execute one stage action now. Parts that are no longer on this vessel are skipped. */
export function executeAction(vessel: Vessel, action: StageAction, stageIndex: number, ctx: StepContext): void {
  wake(vessel);
  vessel.sinceStaging = 0;
  switch (action.kind) {
    case 'igniteEngines':
    case 'fireSeparationMotors': {
      for (const id of action.parts) {
        const i = findPart(vessel, id);
        if (i >= 0) igniteModules(vessel, vessel.parts[i]!, action.kind === 'fireSeparationMotors', ctx);
      }
      break;
    }
    case 'shutdownEngines': {
      for (const id of action.parts) {
        const i = findPart(vessel, id);
        if (i < 0) continue;
        const part = vessel.parts[i]!;
        for (let m = 0; m < part.def.modules.length; m++) {
          const md = part.def.modules[m]!;
          const ms = part.modules[m]!;
          if (md.type === 'engine' && ms.type === 'engine' && !md.fixedBurn) ms.active = false;
        }
      }
      break;
    }
    case 'releaseClamps': {
      const clampIdx = action.parts.map((id) => findPart(vessel, id)).filter((i) => i >= 0);
      if (clampIdx.length === 0) break;
      if (!ctx.instant && action.minThrustToWeight !== undefined && ctx.env) {
        const rr = v3.len(vessel.r);
        const g = ctx.env.mu / (rr * rr);
        const weight = vesselMass(vessel) * g;
        if (currentThrust(vessel) < action.minThrustToWeight * weight) {
          // Pad abort: shut everything down, keep the clamps closed and re-arm the stage.
          for (const p of vessel.parts) for (const m of p.modules) if (m.type === 'engine') m.active = false;
          vessel.pending = vessel.pending.filter((pa) => pa.stageIndex !== stageIndex);
          if (stageIndex >= 0) vessel.nextStage = stageIndex;
          break;
        }
      }
      for (const i of clampIdx) for (const m of vessel.parts[i]!.modules) if (m.type === 'launchClamp') m.released = true;
      const cut = clampIdx.filter((i) => vessel.parts[i]!.parent >= 0);
      const created = separateVessel(vessel, cut, [], ctx);
      // The released clamps stay behind as ONE landed structure.
      const clampVessels = created.filter((v) => v.parts.some((p) => p.modules.some((m) => m.type === 'launchClamp')));
      const baseV = clampVessels[0];
      if (baseV) {
        for (let k = 1; k < clampVessels.length; k++) {
          mergeVessels(baseV, clampVessels[k]!);
          const at = ctx.spawned.indexOf(clampVessels[k]!);
          if (at >= 0) ctx.spawned.splice(at, 1);
        }
        baseV.name = 'Launch clamps';
        baseV.hold = 'ground';
        baseV.anchor = null;
        baseV.surface = 'landed';
        baseV.pending = [];
        baseV.sas.enabled = false;
      }
      const stillClamped = vessel.parts.some((p) => p.modules.some((m) => m.type === 'launchClamp' && !m.released));
      if (!stillClamped && vessel.hold === 'clamps') {
        vessel.hold = null;
        vessel.anchor = null;
        vessel.surface = 'none';
      }
      vessel.struct = null;
      computeMassProps(vessel);
      ctx.events.push({ type: 'clampsReleased', ut: ctx.ut, vesselId: vessel.id });
      break;
    }
    case 'decouple':
    case 'jettisonLES': {
      const i = findPart(vessel, action.part);
      if (i < 0) break;
      const part = vessel.parts[i]!;
      let impulse = 0;
      let sepY = 0;
      let already = false;
      for (let m = 0; m < part.def.modules.length; m++) {
        const md = part.def.modules[m]!;
        const ms = part.modules[m]!;
        if (md.type === 'decoupler' && ms.type === 'decoupler') {
          if (ms.fired) already = true;
          ms.fired = true;
          impulse = md.impulse;
          sepY = md.separationPlaneY;
        }
        if (action.kind === 'jettisonLES' && ms.type === 'les') ms.jettisoned = true;
      }
      if (already || part.parent < 0) break;
      const vesselId = vessel.id;
      const created = decouplePart(vessel, i, impulse, sepY, ctx);
      ctx.events.push({ type: 'decoupled', ut: ctx.ut, vesselId, partId: action.part, newVesselIds: created.map((v) => v.id) });
      break;
    }
    case 'jettisonFairing': {
      const i = findPart(vessel, action.part);
      if (i < 0) break;
      const part = vessel.parts[i]!;
      for (let m = 0; m < part.def.modules.length; m++) {
        const md = part.def.modules[m]!;
        const ms = part.modules[m]!;
        if (md.type === 'fairing' && ms.type === 'fairing' && !ms.jettisoned) {
          ms.jettisoned = true;
          const held = vessel.hold;
          const created = jettisonPanels(vessel, i, md.panels, md.impulse, ctx);
          fixHold(vessel, held);
          ctx.events.push({ type: 'fairingJettisoned', ut: ctx.ut, vesselId: vessel.id, partId: action.part, newVesselIds: created.map((v) => v.id) });
          break;
        }
      }
      break;
    }
    case 'deployParachute': {
      for (const id of action.parts) {
        const i = findPart(vessel, id);
        if (i < 0) continue;
        const part = vessel.parts[i]!;
        for (let m = 0; m < part.def.modules.length; m++) {
          const md = part.def.modules[m]!;
          const ms = part.modules[m]!;
          if (md.type === 'parachute' && ms.type === 'parachute' && md.mode === action.mode && ms.state === 'stowed') {
            if (ctx.instant) {
              ms.state = 'full';
              ms.inflation = 1;
              ms.deployAge = 1e3;
            } else {
              ms.state = 'reefed';
              ms.inflation = 0;
              ms.deployAge = 0;
            }
            ctx.events.push({ type: 'chuteDeployed', ut: ctx.ut, vesselId: vessel.id, partId: id, mode: md.mode });
          }
        }
      }
      break;
    }
    case 'cutParachute': {
      for (const id of action.parts) {
        const i = findPart(vessel, id);
        if (i < 0) continue;
        for (const ms of vessel.parts[i]!.modules) {
          if (ms.type === 'parachute' && (ms.state === 'reefed' || ms.state === 'full')) {
            ms.state = 'cut';
            ms.inflation = 0;
            ctx.events.push({ type: 'chuteCut', ut: ctx.ut, vesselId: vessel.id, partId: id });
          }
        }
      }
      break;
    }
    case 'deployLegs': {
      let any = false;
      for (const id of action.parts) {
        const i = findPart(vessel, id);
        if (i < 0) continue;
        const part = vessel.parts[i]!;
        for (let m = 0; m < part.modules.length; m++) {
          const ms = part.modules[m]!;
          const rt = part.rt[m]!;
          if (ms.type === 'legs' && rt.type === 'legs') {
            if (rt.target !== 1) any = true;
            rt.target = 1;
            if (ctx.instant) ms.deploy = 1;
          }
        }
      }
      if (any) ctx.events.push({ type: 'legsToggled', ut: ctx.ut, vesselId: vessel.id, deployed: true });
      break;
    }
    case 'enableRcs': {
      for (const id of action.parts) {
        const i = findPart(vessel, id);
        if (i < 0) continue;
        for (const ms of vessel.parts[i]!.modules) {
          if (ms.type === 'rcs') {
            ms.enabled = true;
            vessel.rcsEnabled = true;
          }
        }
      }
      break;
    }
  }
}

function stageHasParts(vessel: Vessel, actions: readonly TimedStageAction[]): boolean {
  for (const a of actions) for (const id of actionParts(a)) if (findPart(vessel, id) >= 0) return true;
  return false;
}

/** Whether executing `action` on this vessel would still change anything. */
function actionIsLive(vessel: Vessel, action: StageAction): boolean {
  for (const id of actionParts(action)) {
    const i = findPart(vessel, id);
    if (i < 0) continue;
    const part = vessel.parts[i]!;
    switch (action.kind) {
      case 'igniteEngines':
      case 'fireSeparationMotors':
      case 'shutdownEngines':
      case 'deployLegs':
        // Engines and gear stay pressable while their parts are aboard (the gear stage after `G` is a
        // harmless press, never a silent skip to the stage behind it).
        return true;
      case 'releaseClamps':
        if (part.modules.some((m) => m.type === 'launchClamp' && !m.released)) return true;
        break;
      case 'decouple':
      case 'jettisonLES':
        if (part.parent >= 0 && part.modules.some((m) => m.type === 'decoupler' && !m.fired)) return true;
        break;
      case 'jettisonFairing':
        if (part.modules.some((m) => m.type === 'fairing' && !m.jettisoned)) return true;
        break;
      case 'deployParachute':
        for (let m = 0; m < part.def.modules.length; m++) {
          const md = part.def.modules[m]!;
          const ms = part.modules[m]!;
          if (md.type === 'parachute' && ms.type === 'parachute' && md.mode === action.mode && ms.state === 'stowed') return true;
        }
        break;
      case 'cutParachute':
        if (part.modules.some((m) => m.type === 'parachute' && (m.state === 'reefed' || m.state === 'full'))) return true;
        break;
      case 'enableRcs':
        if (part.modules.some((m) => m.type === 'rcs' && !m.enabled)) return true;
        break;
    }
  }
  return false;
}

function stageIsLive(vessel: Vessel, actions: readonly TimedStageAction[]): boolean {
  for (const a of actions) if (actionIsLive(vessel, a)) return true;
  return false;
}

function runSequence(vessel: Vessel, actions: readonly TimedStageAction[], stageIndex: number, ctx: StepContext): void {
  // Queue the delayed ones first so that a split in an immediate action hands them to the right piece.
  for (const a of actions) {
    if (!ctx.instant && a.delay !== undefined && a.delay > 0) vessel.pending.push({ action: a, timeLeft: a.delay, stageIndex });
  }
  for (const a of actions) {
    if (ctx.instant || a.delay === undefined || a.delay <= 0) executeAction(vessel, a, stageIndex, ctx);
  }
}

/**
 * Index of the next stage that can still do something on this vessel. Stages whose parts are gone, or
 * whose effects have all happened already (after an abort: the capsule is free and its RCS is on, so
 * "Capsule separation" has nothing left to do), are skipped: the next press is the next useful one.
 */
export function nextLiveStage(vessel: Vessel): number {
  const stages = vessel.vehicle.stages;
  let i = vessel.nextStage;
  while (i < stages.length && !stageIsLive(vessel, stages[i]!.actions)) i++;
  return i;
}

/** Fire the next entry of the stage stack (the Space bar). */
export function fireNextStage(vessel: Vessel, env: VesselEnvironment): StagingResult {
  const ctx: StepContext = { ut: env.ut, env, instant: false, events: [], spawned: [] };
  if (vessel.stageLockout > 0) return { ok: false, reason: 'Staging locked out', events: [], spawned: [] };
  const stages = vessel.vehicle.stages;
  const idx = nextLiveStage(vessel);
  if (idx >= stages.length) return { ok: false, reason: 'No stages left', events: [], spawned: [] };
  const stage = stages[idx]!;
  vessel.nextStage = idx + 1;
  vessel.stageLockout = STAGE_LOCKOUT;
  ctx.events.push({ type: 'stageFired', ut: env.ut, vesselId: vessel.id, stageIndex: idx, label: stage.label });
  runSequence(vessel, stage.actions, idx, ctx);
  return { ok: true, events: ctx.events, spawned: ctx.spawned };
}

/** Run the vehicle's abort sequence (Backspace). */
export function abort(vessel: Vessel, env: VesselEnvironment): StagingResult {
  if (vessel.vehicle.abort.length === 0) return { ok: false, reason: 'No abort sequence', events: [], spawned: [] };
  if (vessel.stageLockout > 0) return { ok: false, reason: 'Staging locked out', events: [], spawned: [] };
  if (!stageHasParts(vessel, vessel.vehicle.abort)) return { ok: false, reason: 'Nothing left to abort', events: [], spawned: [] };
  const ctx: StepContext = { ut: env.ut, env, instant: false, events: [], spawned: [] };
  vessel.stageLockout = STAGE_LOCKOUT;
  runSequence(vessel, vessel.vehicle.abort, -1, ctx);
  return { ok: true, events: ctx.events, spawned: ctx.spawned };
}

/** Advance the lockout and delayed-action timers by dt and execute what has come due (in queue order). */
export function processPending(vessel: Vessel, dt: number, ctx: StepContext): void {
  if (vessel.stageLockout > 0) vessel.stageLockout = Math.max(0, vessel.stageLockout - dt);
  vessel.sinceStaging += dt;
  if (vessel.pending.length === 0) return;
  for (const pa of vessel.pending) pa.timeLeft -= dt;
  // An executed action may split the vessel and re-distribute the queue, so re-scan after each one.
  for (let guard = 0; guard < 64; guard++) {
    const k = vessel.pending.findIndex((pa) => pa.timeLeft <= 1e-9);
    if (k < 0) break;
    const [pa] = vessel.pending.splice(k, 1);
    executeAction(vessel, pa!.action, pa!.stageIndex, ctx);
  }
}

/**
 * Apply stage `stageIndex` structurally: every action at once in its settled end state, no dynamics.
 * Returns the vessels that separate.
 */
export function applyStageInstant(vessel: Vessel, stageIndex: number): Vessel[] {
  const stage = vessel.vehicle.stages[stageIndex];
  if (!stage) throw new Error(`vehicle "${vessel.vehicleId}" has no stage ${stageIndex}`);
  const ctx: StepContext = { ut: 0, env: null, instant: true, events: [], spawned: [] };
  runSequence(vessel, stage.actions, stageIndex, ctx);
  vessel.nextStage = Math.max(vessel.nextStage, stageIndex + 1);
  vessel.sinceStaging = Infinity;
  for (const v of ctx.spawned) v.sinceStaging = Infinity;
  structureOf(vessel);
  return ctx.spawned;
}

// ------------------------------------------------------------------------------------------- toggles

export function setLegsDeployed(vessel: Vessel, deployed: boolean, ut: number): SimEvent[] {
  const events: SimEvent[] = [];
  let changed = false;
  for (const p of vessel.parts) {
    for (let m = 0; m < p.modules.length; m++) {
      const rt = p.rt[m]!;
      if (rt.type === 'legs' && rt.target !== (deployed ? 1 : 0)) {
        rt.target = deployed ? 1 : 0;
        changed = true;
      }
    }
  }
  if (changed) {
    wake(vessel);
    events.push({ type: 'legsToggled', ut, vesselId: vessel.id, deployed });
  }
  return events;
}

/** Null when the vessel has no legs; otherwise whether they are commanded down. */
export function legsDeployed(vessel: Vessel): boolean | null {
  let found = false;
  let down = true;
  for (const p of vessel.parts) {
    for (const rt of p.rt) {
      if (rt.type === 'legs') {
        found = true;
        if (rt.target !== 1) down = false;
      }
    }
  }
  return found ? down : null;
}

export function toggleLegs(vessel: Vessel, ut: number): SimEvent[] {
  const state = legsDeployed(vessel);
  return state === null ? [] : setLegsDeployed(vessel, !state, ut);
}

export function setLights(vessel: Vessel, on: boolean): void {
  vessel.lightsOn = on;
  for (const p of vessel.parts) for (const m of p.modules) if (m.type === 'light') m.on = on;
}

export function setRcsEnabled(vessel: Vessel, on: boolean): void {
  vessel.rcsEnabled = on;
}

export function setFineControl(vessel: Vessel, on: boolean): void {
  vessel.fineControl = on;
}
