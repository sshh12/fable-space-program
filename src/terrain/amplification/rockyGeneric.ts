/**
 * 'rocky-generic': airless or thin-atmosphere rocky and dusty surfaces (Mercury, Venus, Mars, Phobos, Deimos,
 * Io, Ceres). Parameters: data/defs/terrain/rocky-generic.amplification.json; algorithm: generic.ts.
 */
import type { TerrainAmplificationDef } from '../../core/contracts/defs';
import { createGenericModel } from './generic';
import type { AmplificationModel, ModelContext } from './types';

export function createRockyGeneric(def: TerrainAmplificationDef, ctx: ModelContext): AmplificationModel {
  return createGenericModel('rocky-generic', def, ctx);
}
