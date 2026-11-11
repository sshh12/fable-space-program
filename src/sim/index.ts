/**
 * The simulation package. `createSim(defs, scenarioId, { terrain })` builds the world orchestrator, the
 * implementation of the `Sim` contract (src/core/contracts/sim.ts). Everything else under src/sim is
 * internal to the simulation; presentation code talks to the contract only (the vehicle, cockpit and vfx
 * labs may additionally use the frozen facade src/sim/vessel/public.ts).
 */
export { createSim, type CreateSimOptions, type DebrisFate, type SimWorld, type WorldStats } from './world/sim';
