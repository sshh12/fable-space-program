/**
 * Generator registry: `PartVisualDef.generator` id -> function that builds the part's models.
 * Adding a new kind of part is one entry here plus a visuals file under data/defs/visuals/parts/.
 */
import type { DefLibrary, PartDef } from '@/core/contracts/defs';
import type { PartGenerator, PartVisual } from './types';

const generators = new Map<string, PartGenerator>();

export function registerGenerator(id: string, generator: PartGenerator): void {
  generators.set(id, generator);
}

export function generatorIds(): string[] {
  return [...generators.keys()].sort();
}

export function hasGenerator(id: string): boolean {
  return generators.has(id);
}

/** Build the visual of a part definition. Throws when the part has no visual file or an unknown generator. */
export function generatePart(defs: DefLibrary, def: PartDef): PartVisual {
  if (!def.visual) throw new Error(`part "${def.id}" has no visual definition (data/defs/visuals/parts/${def.id}.json)`);
  const g = generators.get(def.visual.generator);
  if (!g) throw new Error(`part "${def.id}": unknown generator "${def.visual.generator}"`);
  return g({ def, params: def.visual.params ?? {}, defs });
}
