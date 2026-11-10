/**
 * Public API of the audio package (docs/handoff/audio.md).
 *
 *   createAudioEngine(options?)        the live AudioEngine of src/core/contracts/audio.ts
 *   parseAudioConfig(defs)             validated audio sections (audio/assets, engines, events, environment, mix, ui)
 *   createAudioGraph(ctx, bank, cfg)   the graph over any BaseAudioContext (live or offline)
 *   SoundModel                         pure frame -> targets model (what is heard)
 *   renderOffline(cfg, defs, bank, s)  deterministic offline render with every bus and path captured
 */
export { createAudioEngine, type AudioEngineOptions, type AudioEngineStatus, type FableAudioEngine } from './engine';
export { parseAudioConfig, readSnapshotPath, AUDIO_SECTIONS, ALL_EVENT_TYPES, BUS_NAMES, type AudioConfig, type BusId, type EngineProfile, type EventSoundDef } from './config';
export { createAudioGraph, renderAlarmBuffer, ceilingCurve, TAP_NAMES, type AssetBank, type AudioGraph, type AudioGraphStats, type TapName, type PathName } from './graph';
export { SoundModel, ambienceAssetIds, type ModelOutput, type EngineVoiceTarget, type OneShotRequest, type SourcePaths, type AirPath, type BodyPath, type AmbienceTarget } from './model';
export { renderOffline, type OfflineRender, type OfflineRenderSpec, type OfflineOneShotLog } from './offline';
export { loadAssetBank, type AssetLoadProgress } from './assets';
export { noiseBank, generateNoise, crackleWeights, slowModulator, CRACKLE_LEVELS, NOISE_KINDS, type NoiseKind, type NoiseBank } from './noise';
export * as audioAnalysis from './analysis';
export * as audioMapping from './mapping';
