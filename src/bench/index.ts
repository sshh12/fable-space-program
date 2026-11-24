/**
 * Calibration and graphics settings (ARCHITECTURE 24; docs/handoff/capability-settings.md is the manual):
 * the quality table, the cost model and the solver, the calibration controller over a host page, the CPU
 * score, the settings on this device and the graphics model the settings screen renders.
 */
export { CalibrationNotReady, progressLine, runCalibration, type CalibrationHost, type CalibrationOptions, type CalibrationProgress, type CalibrationResult, type ShotRun } from './calibration';
export { FIXED_GROUP, measureShot, passAssigner, predictGroups, predictShot, profilePixels, type FrameSample, type ShotMeasurement } from './costModel';
export { cpuScoreOf, type CpuReference } from './cpuScore';
export { GraphicsSettings, type GraphicsModel, type GraphicsRow } from './settings';
export { presetOf, scoreOf, solve, stepDown, worstPrediction, type SolveInput, type SolveResult } from './solver';
export { FLOOR_SESSIONS, FLOOR_SHARE, GRAPHICS_STORE_KEY, GRAPHICS_STORE_MAX, readGraphics, wantsFloorPrompt, withFloorShare, writeGraphics, type KeyValueStore, type RerunReason, type StoredGraphics } from './store';
export { parseQualityTable, PRESET_NAMES, presetProfile, seedPreset, type AdapterClass, type PresetName, type QualityTable, type ShotDef } from './table';
export { missingFor, prefetchNeeds, residentFor, type ShotNeeds } from './resident';
export { startGraphics, storeCalibration, storeManual, storeSkip, type GraphicsBoot, type GraphicsBootInput } from './boot';
