/**
 * What a stage of a vehicle says about itself that does not change during a flight: what it burns, what its
 * parachute actions do, and the engines it ignites (requests presentation-sweep-3). A session states these
 * per stage in `StageInfo` (src/core/contracts/sim.ts: `burnLabel`, `thrustVac`, `weightFlowVac`,
 * `actionChutes`, `chuteEnvelopes`), so that no consumer indexes `defs.vehicles` by a runtime id for words.
 *
 * ONE derivation for every producer: the simulation's snapshot builder (src/sim/vessel/facade.ts) and the
 * fakes (src/core/fakes) both call `describeStages`, so a FakeSession states what a real session states.
 * It reads the vehicle the craft was BUILT FROM and the part definitions its placements name; nothing of it
 * enters a vessel's state.
 *
 * The values are, to the bit and to the letter, what the flight HUD computed from the definitions before
 * these fields existed (src/ui/model.ts: stageBurnLabel, stageActionWords, stageAcceleration,
 * describeChuteEnvelope): the same iteration orders, the same sums in the same order.
 */
import type { ParachuteEnvelope, PartDef, VehicleDef } from '../contracts/defs';

export type ChuteKind = 'drogue' | 'main';

export interface StageWords {
  /**
   * The labels of the stage groups (`VehicleDef.stageGroups`) of the engines the stage's ignite actions
   * light, each group once, in the order the actions name their parts, joined with ' + ' ("Meridian M-3");
   * a group without a label is named by its id. null for a stage that ignites no engine of a stage group.
   */
  burnLabel: string | null;
  /**
   * Of the engines the stage ignites (every engine module of every part its ignite actions name; fixed-burn
   * motors and engines without a vacuum Isp left out): the thrust in vacuum, N, and the propellant's weight
   * flow at standard gravity, N/s (the sum of thrustVac / ispVac: mass flow times g0). Both 0 when there is
   * none. The effective exhaust velocity is g0 * thrustVac / weightFlowVac.
   */
  thrustVac: number;
  weightFlowVac: number;
  /**
   * One entry per action of the stage, in the order of the stage's actions (the order of
   * `StageInfo.actionKinds`): for a 'deployParachute' action the kind of canopy it deploys; for a
   * 'cutParachute' action the kind it releases, which is the kind the latest deploy action before it put out
   * (in an earlier stage or earlier in this one), null when nothing was deployed before it; null for every
   * other action.
   */
  actionChutes: (ChuteKind | null)[];
  /**
   * The envelopes of the canopy the stage's FIRST deploy action puts out: `safe` and `destroy` of the
   * parachute module of that kind on the first part of the vehicle (in the order of `VehicleDef.parts`) that
   * the action names. null when the stage deploys no parachute, or that part has no parachute module of the
   * kind.
   */
  chuteEnvelopes: { safe: ParachuteEnvelope; destroy: ParachuteEnvelope } | null;
}

/** The part definition of an id, or nothing when the library does not have it. */
export type PartDefSource = (defId: string) => PartDef | null | undefined;

/** One `StageWords` per stage of `vehicle.stages`, in order. Pure: the same vehicle and parts give the same answer. */
export function describeStages(vehicle: VehicleDef, partDef: PartDefSource): StageWords[] {
  const out: StageWords[] = [];
  let deployed: ChuteKind | null = null;
  for (const stage of vehicle.stages) {
    const groups: string[] = [];
    let thrust = 0;
    let flow = 0;
    const actionChutes: (ChuteKind | null)[] = [];
    let chuteEnvelopes: StageWords['chuteEnvelopes'] = null;
    let sawDeploy = false;
    for (const a of stage.actions) {
      if (a.kind === 'igniteEngines') {
        for (const id of a.parts) {
          const placement = vehicle.parts.find((p) => p.id === id);
          const g = placement?.stageGroup;
          if (g !== undefined && !groups.includes(g)) groups.push(g);
          const def = partDef(placement?.def ?? '');
          for (const m of def?.modules ?? []) {
            if (m.type !== 'engine' || m.fixedBurn || !(m.ispVac > 0)) continue;
            thrust += m.thrustVac;
            flow += m.thrustVac / m.ispVac;
          }
        }
      }
      if (a.kind === 'deployParachute') {
        actionChutes.push(a.mode);
        if (!sawDeploy) {
          sawDeploy = true;
          const def = partDef(vehicle.parts.find((p) => a.parts.includes(p.id))?.def ?? '');
          const md = def?.modules.find((m) => m.type === 'parachute' && m.mode === a.mode);
          chuteEnvelopes = md?.type === 'parachute' ? { safe: md.safe, destroy: md.destroy } : null;
        }
        deployed = a.mode;
      } else if (a.kind === 'cutParachute') actionChutes.push(deployed);
      else actionChutes.push(null);
    }
    out.push({
      burnLabel: groups.length === 0 ? null : groups.map((g) => vehicle.stageGroups.find((x) => x.id === g)?.label ?? g).join(' + '),
      thrustVac: thrust,
      weightFlowVac: flow,
      actionChutes,
      chuteEnvelopes,
    });
  }
  return out;
}

const remembered = new WeakMap<VehicleDef, StageWords[]>();

/**
 * `describeStages` of a vehicle, computed once per vehicle object and kept (the answer depends on the
 * definitions alone). Called where a craft is made from its vehicle with the part library at hand (the
 * assembly, the decoder); `rememberedStages` then answers without a library.
 */
export function rememberStages(vehicle: VehicleDef, partDef: PartDefSource): StageWords[] {
  let words = remembered.get(vehicle);
  if (!words) {
    words = describeStages(vehicle, partDef);
    remembered.set(vehicle, words);
  }
  return words;
}

/** What `rememberStages` kept for this vehicle object; undefined when it was never asked. */
export function rememberedStages(vehicle: VehicleDef): StageWords[] | undefined {
  return remembered.get(vehicle);
}
