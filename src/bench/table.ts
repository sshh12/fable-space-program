/**
 * The quality table (data/defs/render/quality.json; ARCHITECTURE 24, frontend-ux 9.3-9.6): presets as an
 * internal pixel cap plus every declared setting at the preset's own level, the preset of each adapter
 * class hint, the solver's numbers, the calibration's shots and how GPU passes are attributed to settings.
 * Read with `parseQualityTable` (it refuses a malformed file with the field it stumbled on).
 */
import type { CapabilityReport } from '@/core/contracts/net';
import type { QualityLevelName, QualityProfile } from '@/core/contracts/render';
import type { CpuReference } from './cpuScore';
import type { ShotNeeds } from './resident';

export type PresetName = QualityLevelName;
export const PRESET_NAMES: readonly PresetName[] = ['low', 'medium', 'high', 'ultra'];
export type AdapterClass = CapabilityReport['adapterClass'];

/** One calibration shot (frontend-ux 9.3): a scenario of data/defs/scenarios flown by the scripted pilot. */
export interface ShotDef {
  id: string;
  label: string;
  /** Scenario id (data/defs/scenarios/bench-*.json). */
  scenario: string;
  /** 'chase': the chase camera at `chaseDistanceM`; 'cockpit': the commander's seat. */
  camera: 'chase' | 'cockpit';
  chaseDistanceM: number;
  settleS: number;
  measureS: number;
  /** The pilot ignites and releases the clamps at the start of the measurement. */
  ignite: boolean;
}

export interface QualityTable {
  benchVersion: number;
  targetFps: number;
  presets: Record<PresetName, { pixelCap: number; renderScaleMin: number }>;
  classHint: Record<AdapterClass, PresetName>;
  safePreset: PresetName;
  solver: {
    /** The solver keeps every shot's predicted p95 under this share of the governor's budget. */
    budgetShare: number;
    /** The internal pixel caps it chooses between, megapixels, ascending. */
    pixelCaps: number[];
    /** Perceptual weight of one step of the pixel cap (the settings' weights are in their declarations). */
    resolutionWeight: number;
    /** Step-downs after a confirmation run over the budget, at most. */
    confirmStepsMax: number;
    /** Below this, at this preset, in the confirmation shot, the GPU is below the minimum (a warning). */
    minimum: { preset: PresetName; frameMs: number };
  };
  shots: ShotDef[];
  confirm: { shot: string; measureS: number };
  /** The CPU score's reference machine (cpuScore.ts). */
  cpuReference: CpuReference;
  /**
   * What each shot reads from a cold page (resident.ts), one entry per shot; null when the file has none
   * recorded: then nothing is ever resident and a calibration cannot start.
   */
  needs: ShotNeeds[] | null;
  attribution: {
    /** Setting id -> regular expression over pass names (attribution mode: `<featureId>.<pass>`). */
    rules: Record<string, string>;
    /** Passes never counted (the lab ballast). */
    ignore: string;
    /** How the fixed cost follows the internal pixel count: (pixels / measured pixels) ^ fixedExponent. */
    fixedExponent: number;
  };
}

class TableError extends Error {
  constructor(field: string, what: string) {
    super(`quality.json: ${field} ${what}`);
  }
}

const num = (v: unknown, field: string, min = -Infinity, max = Infinity): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new TableError(field, `must be a number in [${min}, ${max}]`);
  return v;
};
const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || v.length === 0) throw new TableError(field, 'must be a non-empty string');
  return v;
};
const obj = (v: unknown, field: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new TableError(field, 'must be an object');
  return v as Record<string, unknown>;
};
const preset = (v: unknown, field: string): PresetName => {
  if (!PRESET_NAMES.includes(v as PresetName)) throw new TableError(field, `must be one of ${PRESET_NAMES.join(', ')}`);
  return v as PresetName;
};
const regex = (v: unknown, field: string): string => {
  const s = str(v, field);
  try {
    new RegExp(s);
  } catch {
    throw new TableError(field, 'is not a regular expression');
  }
  return s;
};

export function parseQualityTable(json: unknown): QualityTable {
  const t = obj(json, 'the file');
  const presets = obj(t['presets'], 'presets');
  const solver = obj(t['solver'], 'solver');
  const minimum = obj(solver['minimum'], 'solver.minimum');
  const hint = obj(t['classHint'], 'classHint');
  const attribution = obj(t['attribution'], 'attribution');
  const rules = obj(attribution['rules'], 'attribution.rules');
  const confirm = obj(t['confirm'], 'confirm');
  const cpu = obj(t['cpuReference'], 'cpuReference');
  if (!Array.isArray(t['shots']) || t['shots'].length === 0) throw new TableError('shots', 'must be a non-empty list');
  const shots = (t['shots'] as unknown[]).map((s, i): ShotDef => {
    const o = obj(s, `shots[${i}]`);
    const camera = o['camera'];
    if (camera !== 'chase' && camera !== 'cockpit') throw new TableError(`shots[${i}].camera`, "must be 'chase' or 'cockpit'");
    if (typeof o['ignite'] !== 'boolean') throw new TableError(`shots[${i}].ignite`, 'must be true or false');
    return {
      id: str(o['id'], `shots[${i}].id`),
      label: str(o['label'], `shots[${i}].label`),
      scenario: str(o['scenario'], `shots[${i}].scenario`),
      camera,
      chaseDistanceM: num(o['chaseDistanceM'], `shots[${i}].chaseDistanceM`, 0),
      settleS: num(o['settleS'], `shots[${i}].settleS`, 0, 30),
      measureS: num(o['measureS'], `shots[${i}].measureS`, 0.5, 30),
      ignite: o['ignite'],
    };
  });
  const pixelCaps = solver['pixelCaps'];
  if (!Array.isArray(pixelCaps) || pixelCaps.length === 0) throw new TableError('solver.pixelCaps', 'must be a non-empty list');
  const caps = pixelCaps.map((c, i) => num(c, `solver.pixelCaps[${i}]`, 0.1, 40));
  for (let i = 1; i < caps.length; i++) if (caps[i]! <= caps[i - 1]!) throw new TableError('solver.pixelCaps', 'must ascend');
  const table: QualityTable = {
    benchVersion: num(t['benchVersion'], 'benchVersion', 1),
    targetFps: num(t['targetFps'], 'targetFps', 20, 360),
    presets: Object.fromEntries(
      PRESET_NAMES.map((n) => {
        const p = obj(presets[n], `presets.${n}`);
        return [n, { pixelCap: num(p['pixelCap'], `presets.${n}.pixelCap`, 0.1, 40), renderScaleMin: num(p['renderScaleMin'], `presets.${n}.renderScaleMin`, 0.1, 1) }];
      }),
    ) as QualityTable['presets'],
    classHint: { discrete: preset(hint['discrete'], 'classHint.discrete'), unknown: preset(hint['unknown'], 'classHint.unknown'), integrated: preset(hint['integrated'], 'classHint.integrated') },
    safePreset: preset(t['safePreset'], 'safePreset'),
    solver: {
      budgetShare: num(solver['budgetShare'], 'solver.budgetShare', 0.1, 1),
      pixelCaps: caps,
      resolutionWeight: num(solver['resolutionWeight'], 'solver.resolutionWeight', 0),
      confirmStepsMax: num(solver['confirmStepsMax'], 'solver.confirmStepsMax', 0, 8),
      minimum: { preset: preset(minimum['preset'], 'solver.minimum.preset'), frameMs: num(minimum['frameMs'], 'solver.minimum.frameMs', 1) },
    },
    shots,
    confirm: { shot: str(confirm['shot'], 'confirm.shot'), measureS: num(confirm['measureS'], 'confirm.measureS', 0.5, 30) },
    needs: t['needs'] === undefined ? null : parseNeeds(t['needs']),
    cpuReference: { frameP95Ms: num(cpu['frameP95Ms'], 'cpuReference.frameP95Ms', 0.01), simMs: num(cpu['simMs'], 'cpuReference.simMs', 0.01), simSteps: num(cpu['simSteps'], 'cpuReference.simSteps', 1) },
    attribution: {
      rules: Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, regex(v, `attribution.rules.${k}`)])),
      ignore: regex(attribution['ignore'], 'attribution.ignore'),
      fixedExponent: num(attribution['fixedExponent'], 'attribution.fixedExponent', 0, 2),
    },
  };
  if (!table.shots.some((s) => s.id === table.confirm.shot)) throw new TableError('confirm.shot', `names no shot of the list (${table.shots.map((s) => s.id).join(', ')})`);
  if (new Set(table.shots.map((s) => s.id)).size !== table.shots.length) throw new TableError('shots', 'have duplicate ids');
  return table;
}

function parseNeeds(v: unknown): ShotNeeds[] {
  if (!Array.isArray(v)) throw new TableError('needs', 'must be a list (one entry per shot)');
  return v.map((n, i) => {
    const o = obj(n, `needs[${i}]`);
    const paths = o['paths'];
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string' && p.startsWith('/'))) throw new TableError(`needs[${i}].paths`, 'must be a non-empty list of URL paths');
    return { shotId: str(o['shotId'], `needs[${i}].shotId`), paths: paths as string[], bytes: num(o['bytes'], `needs[${i}].bytes`, 0) };
  });
}

/** A preset as a profile: its pixel cap and floor, every listed setting at the preset's own level. */
export function presetProfile(table: QualityTable, name: PresetName, settingIds: readonly string[]): QualityProfile {
  const p = table.presets[name];
  return { pixelCap: p.pixelCap, renderScaleMin: p.renderScaleMin, targetFps: table.targetFps, levels: Object.fromEntries(settingIds.map((id) => [id, name])) };
}

/** The preset before a calibration: `?safe=1` gives the safe preset, otherwise the adapter class hint's. */
export function seedPreset(table: QualityTable, adapterClass: AdapterClass, safe: boolean): PresetName {
  return safe ? table.safePreset : table.classHint[adapterClass];
}
