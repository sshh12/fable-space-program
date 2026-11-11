/**
 * The scripted test pilot inside the page (ARCHITECTURE 18.2): the same pilot that flies the headless mission
 * (src/pilot), driven by the simulation's own control ticks, `Sim.advance(realDt, onControlTick)`, 30 times a
 * second of simulation time. Inside a tick it reads `sim.peek()` and answers with `sim.setControls()` and
 * `sim.commands`: the two interfaces the keyboard uses. It never touches vehicle state, time or the debug API.
 *
 * While the pilot flies, the app does not hand the keyboard controller's output to the simulation (the pilot's
 * latched controls would otherwise be overwritten every frame); view, map, HUD and pause keys keep working.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { Sim } from '@/core/contracts/sim';
import { createMissionPilot, type MissionPilot } from '@/pilot';

export interface PilotDriver {
  /** True while the pilot is flying. */
  readonly engaged: boolean;
  /** The pilot of the last start (also after it finished or gave up), null before the first start. */
  readonly pilot: MissionPilot | null;
  start(): void;
  stop(): void;
  /** The control-tick callback for `Sim.advance` while engaged, else undefined. */
  readonly onControlTick: (() => void) | undefined;
  /** Called once per frame after the advance: disengages when the pilot is done or has given up. */
  afterFrame(): { finished: boolean };
}

export function createPilotDriver(defs: DefLibrary, sim: Sim): PilotDriver {
  let pilot: MissionPilot | null = null;
  let engaged = false;
  let prevUt = 0;

  const tick = (): void => {
    if (!engaged || !pilot) return;
    const s = sim.peek();
    sim.setControls(pilot.update(s, sim.commands, s.simUt - prevUt));
    prevUt = s.simUt;
  };

  return {
    get engaged() {
      return engaged;
    },
    get pilot() {
      return pilot;
    },
    get onControlTick() {
      return engaged ? tick : undefined;
    },
    start() {
      if (engaged) return;
      // The pilot starts in the phase that fits the state it finds, so a fresh one is made for every start.
      pilot = createMissionPilot(defs, sim.scenario);
      prevUt = sim.peek().simUt;
      engaged = true;
    },
    stop() {
      engaged = false;
    },
    afterFrame() {
      if (!engaged || !pilot) return { finished: false };
      const s = sim.peek();
      if (pilot.done || pilot.failure !== null || s.mission.failed) {
        engaged = false;
        return { finished: true };
      }
      return { finished: false };
    },
  };
}
