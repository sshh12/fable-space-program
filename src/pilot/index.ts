/**
 * The scripted test pilot and the headless flight loop. The pilot reaches the simulation only through the
 * Sim contract of src/core (peek / setControls / commands); nothing here imports src/sim.
 */
export { createMissionPilot, ENTRY_DOWN_RANGE, type MissionPilot, type MissionPilotOptions } from './missionPilot';
export { NOMINAL_PITCH_PROGRAMME, SLOPPY_PITCH_PROGRAMME, type PitchProgramme } from './guidance';
export type { PilotLogEntry } from './core';
export { replayHeadless, runHeadless, RAILS_FRAME, type InputLogEntry, type LoggedCommand, type RunContext, type RunOptions, type RunResult, type RunStats, type StopReason } from './runner';
