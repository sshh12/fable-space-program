/**
 * The module behaviour the new parts need (fleet-data scope B): command authority of remote command parts, the
 * nuclear engine's slow spool, and a docking port's state as data (armed, occupied by a stacked part, shielded,
 * docked to a port mated in the file). Capture itself is the next wave's.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary, VehicleDef } from '@/core/contracts/defs';
import type { DockingPortState } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { assembleVessel, splitForStage } from '@/sim/vessel/public';
import { armPort, portConditions, portModulesOf, portStateAt, refreshPortStates } from '@/sim/vessel/modules/dockingPortState';
import { givesCommandAuthority, hasCommandAuthority, isRemoteCapable } from '@/sim/vessel/modules/remoteCommand';
import { structureOf } from '@/sim/vessel/structure';
import type { Vessel } from '@/sim/vessel/types';
import { updateEngines } from '@/sim/vessel/modules/engine';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
});

const portOf = (v: Vessel, id: string): { index: number; state: DockingPortState } => {
  const i = v.parts.findIndex((p) => p.instanceId === id);
  const m = portModulesOf(v.parts[i]!)[0]!;
  return { index: i, state: portStateAt(v.parts[i]!, m.index) };
};

describe('command authority', () => {
  it('a remote command part flies without crew; a crewed capsule needs its crew', () => {
    const atoll = assembleVessel(defs, 'solstice-atoll');
    const ring = atoll.parts.find((p) => p.instanceId === 'sc-ring')!;
    const core = atoll.parts.find((p) => p.instanceId === 'sc-core')!;
    expect(isRemoteCapable(ring)).toBe(true);
    expect(givesCommandAuthority(ring)).toBe(true);
    // The station core seats six but is launched empty and has no remote avionics of its own.
    expect(givesCommandAuthority(core)).toBe(false);
    expect(hasCommandAuthority(atoll)).toBe(true);
    const kestrel = assembleVessel(defs, 'solstice-kestrel');
    const capsule = kestrel.parts.find((p) => p.instanceId === 'sc-capsule')!;
    expect(givesCommandAuthority(capsule)).toBe(true);
    for (const m of capsule.modules) if (m.type === 'command') m.crewAlive = false;
    expect(givesCommandAuthority(capsule)).toBe(false);
    expect(hasCommandAuthority(kestrel)).toBe(false);
  });
});

describe('the nuclear engine spools slowly', () => {
  it('Canopus-N: about 95 % of full thrust 20 s after the lever opens, under 5 % 30 s after it closes', () => {
    const v = assembleVessel(defs, 'meridian-albatross', { stagesAlreadyFired: 4 });
    const st = structureOf(v);
    const ntr = st.engines.filter((e) => e.def.propellants.length === 1 && e.def.propellants[0]!.resource === 'LH2');
    expect(ntr).toHaveLength(3);
    const full = ntr.reduce((s, e) => s + e.def.thrustVac, 0);
    const run = (lever: number, seconds: number): number => {
      let out = 0;
      for (let t = 0; t < seconds * 120; t++) out = updateEngines(v, st, lever, 0, 1 / 120, t / 120, []).thrust;
      return out;
    };
    expect(run(1, 1) / full).toBeLessThan(0.2);
    const up = run(1, 19);
    expect(up / full).toBeGreaterThan(0.94);
    expect(up / full).toBeLessThan(0.97);
    const down = run(0, 30);
    expect(down / full).toBeLessThan(0.06);
    expect(down / full).toBeGreaterThan(0.03);
  });
});

describe('a docking port as data', () => {
  it('the ferry port under the escape tower is occupied until the tower goes; then it is disarmed, then ready when armed', () => {
    let v = assembleVessel(defs, 'solstice-kestrel');
    expect(portOf(v, 'sc-port').state).toMatchObject({ type: 'dockingPort', state: 'occupied', armed: false, peer: null, progress: 0 });
    expect(portConditions(v, portOf(v, 'sc-port').index, portModulesOf(v.parts[portOf(v, 'sc-port').index]!)[0]!.index).occupiedBy).toBe('sc-les');
    // Fire the stages to the tower jettison (launch, stage 1 separation, tower and fairing).
    for (let i = 0; i < 3; i++) v = splitForStage(defs, v, i).vessel;
    refreshPortStates(v);
    const port = portOf(v, 'sc-port');
    expect(port.state.state).toBe('disabled');
    expect(armPort(v, port.index, true)).toBe(true);
    expect(portOf(v, 'sc-port').state).toMatchObject({ state: 'ready', armed: true });
    expect(armPort(v, v.parts.findIndex((p) => p.instanceId === 'sc-capsule'), true)).toBe(false);
  });

  it('a port shielded by a closed fairing is disabled, armed or not', () => {
    const v = assembleVessel(defs, 'solstice-atoll');
    const { index } = portOf(v, 'sc-fwd-port');
    expect(v.parts[index]!.shielded).toBe(true);
    armPort(v, index, true);
    expect(portOf(v, 'sc-fwd-port').state).toMatchObject({ state: 'disabled', armed: true });
  });

  it('two ports mated face to face in a vehicle file are a docked joint between two craft, each naming the other', () => {
    const tandem: VehicleDef = {
      id: 'test-tandem',
      name: 'Tandem',
      parts: [
        { id: 'a', def: 'pathfinder-bus', parent: null, stageGroup: 'a' },
        { id: 'a-port', def: 'dock-port-c', parent: 'a', parentNode: 'top', node: 'bottom', stageGroup: 'a' },
        { id: 'b-port', def: 'dock-port-c', parent: 'a-port', parentNode: 'face', node: 'face', stageGroup: 'b' },
        { id: 'b', def: 'pathfinder-bus', parent: 'b-port', parentNode: 'bottom', node: 'top', stageGroup: 'b' },
      ],
      stageGroups: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      stages: [],
      abort: [],
      actionGroups: {},
      crew: [],
      cameras: { chase: { defaultDistance: 10, minDistance: 2, maxDistance: 100 } },
      cockpit: null,
    };
    const lib = { ...defs, vehicles: { ...defs.vehicles, [tandem.id]: tandem } };
    const v = assembleVessel(lib, tandem.id);
    expect(v.crafts).toHaveLength(2);
    expect(v.links).toHaveLength(1);
    const a = portOf(v, 'a-port').state;
    const b = portOf(v, 'b-port').state;
    expect(a.state).toBe('hard');
    expect(b.state).toBe('hard');
    expect(a.peer).toEqual({ vesselId: v.id, partKey: `${v.crafts[1]!.craftId}/b-port` });
    expect(b.peer).toEqual({ vesselId: v.id, partKey: `${v.crafts[0]!.craftId}/a-port` });
  });

  it('the H-C adapter carries a port of each type, each with its own state', () => {
    const def = defs.parts['dock-adapter-h-c']!;
    const ports = (def.modules as unknown as { type: string; portType?: string; node?: string }[]).filter((m) => m.type === 'dockingPort');
    expect(ports.map((p) => `${p.portType}:${p.node}`)).toEqual(['h:face-h', 'c:face-c']);
  });
});
