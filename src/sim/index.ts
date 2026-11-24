/**
 * The simulation package. It exports NO SESSION: `createSession` of src/session makes the in-process
 * session (`LocalSession`, src/core/contracts/session.ts), which until src/universe exists is the world
 * orchestrator `createWorld` builds. Everything else under src/sim is internal to the simulation;
 * presentation code talks to the contracts only (the vehicle, cockpit and vfx labs may additionally use the
 * frozen facade src/sim/vessel/public.ts). v1's `createSim` is gone since the tighten step after sub-wave
 * 3.2.
 */
export { createWorld, type CreateSimOptions, type DebrisFate, type SimWorld, type WorldStats } from './world/sim';
export { seededCraftIds, type CraftIdSource } from './vessel/ids';
