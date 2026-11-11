/**
 * Part visuals: what a generator returns and how a part state is turned into draw items.
 *
 * A generator builds named models in the PART frame (+Y nose, +X starboard, +Z dorsal; azimuth about +Y
 * from +Z toward +X). 'body' is the static shell; every other model is an articulated or separately
 * instanced sub-model that `pose` places for a given module state (engine gimbal, leg stroke, fairing
 * petal, clamp arm, hot nozzle sections, window panes, lamps). `pose` is a pure function of its input, so
 * the feature, the lab and the unit tests all assemble a part the same way.
 */
import type { DefLibrary, PartDef } from '@/core/contracts/defs';
import type { ModelData } from '@/core/contracts/render';
import type { ModuleState } from '@/core/contracts/sim';
import type { QuatTuple, Vec3Tuple } from '@/core/math';
import type { BuiltMesh } from '../geom/builder';

export type VisualParams = Record<string, number | string | boolean>;

export interface GenContext {
  def: PartDef;
  params: VisualParams;
  defs: DefLibrary;
}

/** A model with its builder meta data (kept for the unit tests). */
export interface PartModel extends ModelData {
  lods: BuiltMesh[];
  /** Projected-size thresholds for the LOD switches (render core default when absent). */
  lodPixels?: readonly number[];
}

/** Presentation state the feature keeps per part instance (history the snapshot does not carry). */
export interface PartAnim {
  /** Temperature of the radiatively cooled nozzle sections, K. */
  nozzleTemp: number;
  /** 0..1 soot from engine firing history; multiplied by the vertex soot weights. */
  soot: number;
  /** 0..1 frost on cryogenic tank skin. */
  frost: number;
  /** 0 = clamp arm holding, 1 = fully retracted. */
  clamp: number;
  /** 0 = antenna stowed, 1 = deployed. */
  antenna: number;
  /** 0..1 lamp brightness (lights on). */
  lamp: number;
}

export const NEUTRAL_ANIM: Readonly<PartAnim> = { nozzleTemp: 0, soot: 0, frost: 0, clamp: 0, antenna: 0, lamp: 0 };

export interface PoseInput {
  def: PartDef;
  modules: readonly ModuleState[];
  /** Fairing debris: the petal index of an instance id `<id>#panel<k>`; null for a whole part. */
  panel: number | null;
  anim: Readonly<PartAnim>;
}

export interface PoseOpts {
  /** Temperature of this item, K (the feature uses the larger of this and the part's skin temperature). */
  temperature?: number;
  /** This item never glows with heat, whatever the part's temperature (glazing, lamp lenses). */
  cold?: boolean;
  /** Dithered coverage 0..1 of this item (1 = solid): layers that thin out, such as rime on a tank. */
  fade?: number;
  castShadow?: boolean;
  /** Multiplier on the material's emissive luminance (lamps). */
  emissive?: number;
  /** Per-item overrides of the part-wide soot / frost levels. */
  soot?: number;
  frost?: number;
  scale?: Vec3Tuple;
}

/** Receives one draw item: model name, position and rotation in the part frame (null = identity). */
export type PoseSink = (model: string, pos: Vec3Tuple | null, rot: QuatTuple | null, opts?: PoseOpts) => void;

export interface PartLight {
  /** Position in the part frame, m. */
  pos: Vec3Tuple;
  /** Second end point of a line light (a bank of lamps, a beam's lit column); absent = a point light. */
  end?: Vec3Tuple;
  /** Linear-sRGB colour times luminous intensity, cd (on the beam axis for a spot). */
  intensity: Vec3Tuple;
  range: number;
  /** A spot: unit beam axis in the part frame (the direction the light travels). */
  dir?: Vec3Tuple;
  /** A spot's half angles [inner, outer], radians (full inside inner, none past outer). */
  cone?: [number, number];
  /** Radius of the emitting face, m (a lamp bank, a lens). */
  radius?: number;
}

export interface PartVisual {
  models: Record<string, PartModel>;
  pose(input: PoseInput, emit: PoseSink): void;
  /** Local lights of the part for a state (floodlights when the lamp is on). */
  lights?(input: PoseInput): PartLight[];
  /**
   * Seconds of full-throttle firing after which the part's engine has sooted it (and the stage it is
   * mounted on) completely. Absent or 0: the part has no engine, or one that burns clean.
   */
  sootSeconds?: number;
}

export type PartGenerator = (ctx: GenContext) => PartVisual;

/** Typed access to generator parameters with defaults and range checks. */
export class Params {
  constructor(
    private readonly p: VisualParams,
    private readonly where: string,
  ) {}
  num(key: string, fallback?: number): number {
    const v = this.p[key];
    if (v === undefined) {
      if (fallback === undefined) throw new Error(`${this.where}: missing numeric parameter "${key}"`);
      return fallback;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${this.where}: parameter "${key}" must be a number`);
    return v;
  }
  str(key: string, fallback?: string): string {
    const v = this.p[key];
    if (v === undefined) {
      if (fallback === undefined) throw new Error(`${this.where}: missing string parameter "${key}"`);
      return fallback;
    }
    if (typeof v !== 'string') throw new Error(`${this.where}: parameter "${key}" must be a string`);
    return v;
  }
  bool(key: string, fallback = false): boolean {
    const v = this.p[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'boolean') throw new Error(`${this.where}: parameter "${key}" must be a boolean`);
    return v;
  }
}

/** Static part: one 'body' model at the part origin. */
export function staticPose(_input: PoseInput, emit: PoseSink): void {
  emit('body', null, null);
}

/** Type guard helpers for module states. */
export function moduleOf<T extends ModuleState['type']>(modules: readonly ModuleState[], type: T, nth = 0): Extract<ModuleState, { type: T }> | null {
  let k = 0;
  for (const m of modules) {
    if (m.type === type) {
      if (k === nth) return m as Extract<ModuleState, { type: T }>;
      k++;
    }
  }
  return null;
}
