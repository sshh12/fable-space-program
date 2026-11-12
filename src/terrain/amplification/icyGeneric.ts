/**
 * 'icy-generic': water-ice and ice-rich surfaces (the icy moons of Jupiter, Saturn, Uranus and Neptune, Pluto
 * and Charon). Parameters: data/defs/terrain/icy-generic.amplification.json; algorithm: generic.ts.
 */
import type { TerrainAmplificationDef } from '../../core/contracts/defs';
import { createGenericModel } from './generic';
import type { AmplificationModel, ModelContext } from './types';

export function createIcyGeneric(def: TerrainAmplificationDef, ctx: ModelContext): AmplificationModel {
  return createGenericModel('icy-generic', def, ctx);
}
