/**
 * The QA scenarios as captures of one nominal flight of `lunar-direct`: while the pilot flies the mission
 * the vehicle's state is taken at eight points. Each scenario places the vehicle configuration of that
 * point (stagesAlreadyFired) at the captured BCI state and time with the resource amounts it held there
 * (ScenarioDef.resources: tanks, thruster propellant, ablator), so body positions, lighting, the
 * trajectory and the vehicle's mass are those of the real mission.
 *
 * Used by tools/sim/captureScenarios.ts (writes data/defs/scenarios/qa-*.json) and by the mission test,
 * which checks that the files on disk are the captures of the flight it has just flown.
 */
import type { ScenarioDef, ScenarioStart } from '@/core/contracts/defs';
import type { SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { timeSincePeriapsis } from '@/core/math/conic';
import { conicStateAt } from '@/pilot/math';

interface Capture {
  id: string;
  name: string;
  /** True when this tick is the one to capture. */
  when: (s: SimSnapshot, phase: string, state: CaptureState) => boolean;
  stagesAlreadyFired: number;
  attitude: 'prograde' | 'retrograde' | 'radialOut';
  /** 'landed' = a landed start at the scenario's landing target instead of a state vector. */
  landed?: boolean;
  /** Take the state this many seconds before the entry interface of the current conic instead of the tick's own. */
  beforeInterface?: number;
}

interface CaptureState {
  phaseStartUt: number;
  phase: string;
  milestoneUt: Map<string, number>;
}

const since = (st: CaptureState, s: SimSnapshot): number => s.simUt - st.phaseStartUt;

/** Altitude of the entry interface the `qa-entry` start is timed from, m. */
const ENTRY_INTERFACE_ALTITUDE = 122000;

const CAPTURES: Capture[] = [
  {
    id: 'qa-leo',
    name: 'QA: parking orbit (third stage and lander stack)',
    when: (s, phase, st) => phase === 'parkingCoast' && since(st, s) > 600,
    stagesAlreadyFired: 4,
    attitude: 'prograde',
  },
  {
    id: 'qa-translunar',
    name: 'QA: translunar coast (lander stack)',
    when: (s, phase, st) => phase === 'coastToMoon' && since(st, s) > 6 * 3600,
    stagesAlreadyFired: 5,
    attitude: 'prograde',
  },
  {
    id: 'qa-lunar-orbit',
    name: 'QA: 100 km lunar orbit (lander stack)',
    when: (s, phase, st) => phase === 'lunarOrbit' && since(st, s) > 1,
    stagesAlreadyFired: 5,
    attitude: 'prograde',
  },
  {
    id: 'qa-powered-descent',
    name: 'QA: descent orbit, 15 km perilune up-range of the landing target',
    when: (s, phase) => phase === 'pdiCoast' && s.readouts.landingTarget !== null && s.readouts.landingTarget.downRange > 0 && s.readouts.landingTarget.downRange < 1.6e6 && s.readouts.altitudeAsl < 40000,
    stagesAlreadyFired: 6,
    attitude: 'retrograde',
  },
  {
    id: 'qa-lunar-surface',
    name: 'QA: landed at the Tranquillity target',
    when: (_s, phase) => phase === 'surface',
    stagesAlreadyFired: 6,
    attitude: 'radialOut',
    landed: true,
  },
  {
    id: 'qa-trans-earth',
    name: 'QA: trans-Earth coast (ascent stage and capsule)',
    when: (s, phase, st) => phase === 'transEarth' && st.milestoneUt.has('EARTH_PERIGEE_TARGETED') && s.simUt - st.milestoneUt.get('EARTH_PERIGEE_TARGETED')! > 12 * 3600 && s.nodes.length === 0,
    stagesAlreadyFired: 7,
    attitude: 'prograde',
  },
  {
    id: 'qa-entry',
    name: 'QA: capsule five minutes before the entry interface',
    // A tick of the coast to the atmosphere, half a minute after the separation (the capsule is alone and has
    // turned its shield forward): the state five minutes before the 122 km interface is taken from the conic.
    when: (s, phase, st) => phase === 'entry' && since(st, s) > 30 && s.readouts.altitudeAsl > 300000 && s.patches.current[0]?.endReason === 'atmosphere',
    stagesAlreadyFired: 8,
    attitude: 'retrograde',
    beforeInterface: 300,
  },
  {
    id: 'qa-drogues',
    name: 'QA: capsule under drogues at 7 km over the recovery zone',
    when: (s, _phase, st) => st.milestoneUt.has('DROGUE_DEPLOY') && s.readouts.altitudeAsl <= 7000,
    stagesAlreadyFired: 9,
    attitude: 'retrograde',
  },
];

export const QA_SCENARIO_IDS: readonly string[] = CAPTURES.map((c) => c.id);

/** State on the current conic `lead` seconds before it comes down through the entry interface. */
function stateBeforeInterface(s: SimSnapshot, bodyRadius: number, lead: number): { ut: number; r: [number, number, number]; v: [number, number, number] } {
  const patch = s.patches.current[0]!;
  const c = patch.conic;
  const rInterface = bodyRadius + ENTRY_INTERFACE_ALTITUDE;
  const nu = -Math.acos(Math.max(-1, Math.min(1, (c.p / rInterface - 1) / c.e)));
  let tInterface = c.tPeriapsis + timeSincePeriapsis(c, nu);
  if (c.period !== null) while (tInterface < s.simUt) tInterface += c.period;
  const ut = tInterface - lead;
  const st = conicStateAt(c, ut);
  return { ut, r: [st.r.x, st.r.y, st.r.z], v: [st.v.x, st.v.y, st.v.z] };
}

/** What every part of the vessel holds, kg rounded to the gram (parts without tanks are left out). */
function resourcesOf(v: VesselSnapshot): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const p of v.parts) {
    const ids = Object.keys(p.resources);
    if (ids.length === 0) continue;
    const amounts: Record<string, number> = {};
    for (const id of ids) amounts[id] = Math.max(0, Math.round(p.resources[id]! * 1000) / 1000);
    out[p.instanceId] = amounts;
  }
  return out;
}

/**
 * Watches a flight of `base` (the mission scenario) and builds the QA scenarios from it. Call `onTick` at
 * every control tick with the snapshot and the pilot's phase; `scenarios()` returns what was captured.
 */
export class ScenarioCapturer {
  private readonly done = new Map<string, ScenarioDef>();
  private readonly st: CaptureState = { phaseStartUt: 0, phase: '', milestoneUt: new Map() };

  constructor(
    private readonly base: ScenarioDef,
    /** Reference radius of every body, m (BodyDef.radius by body id). */
    private readonly bodyRadius: (bodyId: string) => number,
  ) {}

  onTick(s: SimSnapshot, phase: string): void {
    const st = this.st;
    for (const m of s.milestones) if (!st.milestoneUt.has(m.id)) st.milestoneUt.set(m.id, m.ut);
    if (phase !== st.phase) {
      st.phase = phase;
      st.phaseStartUt = s.simUt;
    }
    if (this.done.size === CAPTURES.length) return;
    const base = this.base;
    for (const c of CAPTURES) {
      if (this.done.has(c.id) || !c.when(s, st.phase, st)) continue;
      const v = s.vessels.find((x) => x.id === s.activeVesselId)!;
      let start: ScenarioStart;
      if (c.landed) {
        const t = s.surfaceTargets.find((x) => x.kind === 'landing')!;
        start = { kind: 'landed', bodyId: t.bodyId, latDeg: base.suggestedLanding!.latDeg, lonDeg: base.suggestedLanding!.lonDeg };
      } else start = { kind: 'state', bodyId: v.bodyId, r: [v.r.x, v.r.y, v.r.z], v: [v.v.x, v.v.y, v.v.z], attitude: c.attitude };
      let startUt = s.simUt;
      if (c.beforeInterface !== undefined) {
        const st0 = stateBeforeInterface(s, this.bodyRadius(v.bodyId), c.beforeInterface);
        startUt = st0.ut;
        start = { kind: 'state', bodyId: v.bodyId, r: st0.r, v: st0.v, attitude: c.attitude };
      }
      this.done.set(c.id, {
        id: c.id,
        name: c.name,
        vehicle: base.vehicle,
        site: base.site,
        startUt,
        start,
        stagesAlreadyFired: c.stagesAlreadyFired,
        resources: resourcesOf(v),
        target: base.target,
        suggestedLanding: base.suggestedLanding,
        milestones: [],
      });
    }
  }

  /** The captured scenarios in the order of the mission; throws naming the first capture point that was never reached. */
  scenarios(): ScenarioDef[] {
    return CAPTURES.map((c) => {
      const sc = this.done.get(c.id);
      if (!sc) throw new Error(`capture point "${c.id}" was never reached`);
      return sc;
    });
  }
}

/** The text of a scenario file as the capture tool writes it. */
export const scenarioFileText = (sc: ScenarioDef): string => `${JSON.stringify(sc, null, 2)}\n`;
