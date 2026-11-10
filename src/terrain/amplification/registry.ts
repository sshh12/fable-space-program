/**
 * Registry of amplification models keyed by BodyDef.terrain.amplification.model. A new body type with its
 * own surface character registers a factory here (engine code never branches on a body id).
 */
import type { TerrainAmplificationDef } from '../../core/contracts/defs';
import { createEarthLandcover } from './earthLandcover';
import { createLunarRegolith } from './lunarRegolith';
import type { AmplificationModel, ModelContext } from './types';

export type AmplificationFactory = (def: TerrainAmplificationDef, ctx: ModelContext) => AmplificationModel;

/** 'none': the data surface only (no procedural detail, no rocks). */
export const createNoAmplification: AmplificationFactory = () => ({
  name: 'none',
  modulatorCount: 0,
  usesLandcover: false,
  rocks: null,
  modulators: () => undefined,
  maxLengthLog2: () => -Infinity,
  add: () => undefined,
  material: () => 0,
  addBandRaster: () => undefined,
  rockAbundance: () => 0,
  rockAbundanceBound: () => 0,
  amplitudeBound: () => 0,
  octaveBound: () => 0,
});

const registry = new Map<string, AmplificationFactory>([
  ['none', createNoAmplification],
  ['lunar-regolith', createLunarRegolith],
  ['earth-landcover', createEarthLandcover],
]);

export function registerAmplificationModel(name: string, factory: AmplificationFactory): void {
  registry.set(name, factory);
}

export function createAmplificationModel(def: TerrainAmplificationDef, ctx: ModelContext): AmplificationModel {
  const f = registry.get(def.model);
  if (!f) throw new Error(`body "${ctx.services.bodyId}": unknown terrain amplification model "${def.model}" (registered: ${[...registry.keys()].join(', ')})`);
  return f(def, ctx);
}

export const amplificationModelNames = (): string[] => [...registry.keys()];
