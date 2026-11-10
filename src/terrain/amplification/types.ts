/**
 * Procedural amplification below data resolution: the plug-in interface of the height authority. A model
 * is selected by BodyDef.terrain.amplification.model through the registry (registry.ts).
 *
 * Every component (noise octave, crater class, rock, ripple train) has a characteristic length `len` and is
 * weighted by
 *   - the effective data level E: only components below the data wavelength implied by E (or below a
 *     model-defined multiple of the data posting for craters), with a smooth fade over one octave, and
 *   - the band limit lambdaMin: smootherstep(log2(len / lambdaMin)), i.e. 0 at len <= lambdaMin and 1 at
 *     len >= 2 lambdaMin (C2 in lambdaMin; between two consecutive render levels at most one octave changes).
 * Models are pure functions of position and of the per-point modulators (which depend on the manifest and on
 * resident data only through the data height/slope/land cover at the data scale, never on lambdaMin).
 */
import type { RockField } from '../rocks';

/** Lambda-independent state at a point, filled by the evaluator before a model is called. */
export interface PointInfo {
  /** Position on the datum sphere, m (body-fixed). */
  px: number;
  py: number;
  pz: number;
  /** Effective data level E (fractional). */
  E: number;
  /** log2 of the data wavelength at E (two texels of level E), m. */
  log2LambdaData: number;
  /** Data height and |grad D| (m/m) at the data scale (band limit = data wavelength at E). */
  dataHeight: number;
  dataSlope: number;
  /** LANDCOVER_CLASS weights at the data scale (sum 1); null when the body has no landcover layer. */
  landcover: Float64Array | null;
}

/** Services of the body that models may call (rock thinning at the rock centre, not at the query point). */
export interface BodyServices {
  readonly bodyId: string;
  readonly radius: number;
  /** Sea level when the body has an ocean, else null. */
  readonly seaLevel: number | null;
  /** Weight of launch-pad / terrain flattening at a datum-sphere point, 0 = natural terrain. */
  flattenAt(x: number, y: number, z: number): number;
  /** Effective data level E at a datum-sphere point. */
  effectiveLevelAt(x: number, y: number, z: number): number;
  /**
   * Land-cover class weights at a datum-sphere point at the data scale into `out`. Returns 0 when the body
   * has no landcover layer, 1 when the weights come from final data, 2 when tiles were missing (the best
   * resident ancestor was used and the current query is flagged incomplete).
   */
  landcoverAt(x: number, y: number, z: number, out: Float64Array): 0 | 1 | 2;
  /** Changes whenever any tile of the body becomes resident or is evicted. */
  dataGeneration(): number;
  /** Flag the evaluation in progress as having used non-final data. */
  markIncomplete(): void;
}

/**
 * High-band evaluation over the sample grid of a normal/material map: add every component whose weight
 * differs between the two band limits, i.e. w(len; lambdaN) - w(len; lambdaLow), to `out`, and max-combine
 * the material weight of those components into `material`.
 */
export interface BandRasterJob {
  count: number;
  px: Float64Array;
  py: Float64Array;
  pz: Float64Array;
  /** Per-sample modulators (count x modulatorCount). */
  mod: Float64Array;
  log2LambdaN: number;
  log2LambdaLow: number;
  out: Float64Array;
  material: Float32Array;
  /**
   * Hash cells (xyz triples, sorted) of a shell-in-cell feature class (cell size, shell half-thickness) that
   * can hold a feature of reach `reach` m touching any sample of the tile.
   */
  cells(cell: number, shellHalf: number, reach: number): Int32Array;
  /** Calls fn(sampleIndex, distance^2) for every sample within `reach` metres of the datum point (x, y, z). */
  forEachNear(x: number, y: number, z: number, reach: number, fn: (i: number, d2: number) => void): void;
}

export interface AmplificationModel {
  readonly name: string;
  readonly modulatorCount: number;
  /** True when the model reads land-cover weights (PointInfo.landcover). */
  readonly usesLandcover: boolean;
  /** Rocks of this body (null when the model places none). */
  readonly rocks: RockField | null;
  /** Fill m[o .. o + modulatorCount) from the point info. */
  modulators(pt: PointInfo, m: Float64Array, o: number): void;
  /**
   * log2 of the longest component the model can produce where the data wavelength is 2^log2LambdaData
   * (lets the evaluator skip the model for band limits above it).
   */
  maxLengthLog2(log2LambdaData: number): number;
  /**
   * Add the amplification at P for each band limit (log2 metres) to out[0 .. n). Components with
   * log2(len) >= skipAboveLog2 are omitted (Infinity = all); `withRocks` = false leaves out rock bumps (rock
   * base heights). Canonical: the same arguments give bit-identical results on every call path.
   */
  add(px: number, py: number, pz: number, m: Float64Array, o: number, log2Lambdas: Float64Array, n: number, out: Float64Array, skipAboveLog2: number, withRocks: boolean): void;
  /** Material weight 0..1 at P from components with log2(len) in [minLog2, maxLog2). */
  material(px: number, py: number, pz: number, m: Float64Array, o: number, minLog2: number, maxLog2: number): number;
  /** See BandRasterJob. */
  addBandRaster(job: BandRasterJob): void;
  /** Local rock area fraction at a datum point (0 = none). */
  rockAbundance(x: number, y: number, z: number): number;
  /** Upper bound of rockAbundance within `extent` m (per axis) of a point; Infinity when unknown. */
  rockAbundanceBound(x: number, y: number, z: number, extent: number): number;
  /**
   * Bound on |amplification| from components with len > 2^log2Lambda, anywhere the effective level is >=
   * minE (conservative; for tile height ranges).
   */
  amplitudeBound(log2Lambda: number, minE: number): number;
  /**
   * Bound on |A(lambda) - A(lambda / 2)| at a point with modulators m: the amplitude of one octave of
   * components around lambda (bounded morph between consecutive render levels).
   */
  octaveBound(log2Lambda: number, m: Float64Array, o: number): number;
}

/** Everything a model factory gets besides its definition. */
export interface ModelContext {
  services: BodyServices;
  /** Global maximum height level of the body's tile set (E >= this everywhere). */
  globalMaxLevel: number;
  /** log2 of the finest wavelength any caller can request (normal band limit at maxRenderLevel). */
  log2FinestLambda: number;
  /** Data wavelength at level 0: lambda_data(E) = lambda0 * 2^-E. */
  lambda0: number;
}
