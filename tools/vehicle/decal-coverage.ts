/**
 * Writes the cut-out copy of the decal atlas: public/assets/vehicle/decals_cut.png, the atlas of
 * tools/vehicle/bake-decals.ts with an alpha channel that holds only the INK of every marking that is painted
 * straight onto a surface.
 *
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/vehicle/decal-coverage.ts
 *
 * A marking whose background is one of the sheet's `skinColors` (the paint or film of the surface it goes
 * on) is keyed: alpha is how far a texel is from that background, so the material 'decal-cut' draws the
 * lettering and leaves the skin under it to show between the letters, with the skin's own weathering, soot
 * and frost. A marking with any other background is a plate with a colour of its own (a yellow caution
 * placard, a dark name plate) and stays whole. Run it after every bake of the atlas.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { fsDefSource } from '../../src/core/defs/fsSource';
import { getSection, loadDefs } from '../../src/core/defs/loader';
import { DECAL_SECTION, layoutDecals, type DecalSheetDef } from '../../src/render/vehicle/decals';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'assets', 'vehicle');

const defs = await loadDefs(fsDefSource());
const sheet = getSection<DecalSheetDef>(defs, DECAL_SECTION);
const layout = layoutDecals(sheet);
const skin = new Set((sheet.skinColors ?? []).map((c) => c.toLowerCase()));
const src = PNG.sync.read(fs.readFileSync(path.join(dir, 'decals.png')));
if (src.width !== sheet.size || src.height !== sheet.size) throw new Error(`decals.png is ${src.width} x ${src.height}, the sheet says ${sheet.size}`);
const out = new PNG({ width: src.width, height: src.height });
// Outside every marking: nothing.
out.data.fill(0);
let keyed = 0;
for (const d of sheet.decals) {
  const r = layout[d.name]!;
  const key = skin.has(d.bg.toLowerCase()) ? [parseInt(d.bg.slice(1, 3), 16), parseInt(d.bg.slice(3, 5), 16), parseInt(d.bg.slice(5, 7), 16)] : null;
  if (key) keyed++;
  // (The bake bleeds every marking's background 6 texels past its rectangle for the mip chain.)
  for (let y = Math.max(0, r.y - 6); y < Math.min(src.height, r.y + r.h + 6); y++) {
    for (let x = Math.max(0, r.x - 6); x < Math.min(src.width, r.x + r.w + 6); x++) {
      const i = (y * src.width + x) * 4;
      const c = [src.data[i]!, src.data[i + 1]!, src.data[i + 2]!];
      const ink = key ? Math.min(1, Math.max(Math.abs(c[0]! - key[0]!), Math.abs(c[1]! - key[1]!), Math.abs(c[2]! - key[2]!)) / 48) : 1;
      // The colour of a partly covered texel is the ink's, not its blend with the background.
      for (let k = 0; k < 3; k++) out.data[i + k] = key && ink > 0.02 ? Math.max(0, Math.min(255, Math.round(key[k]! + (c[k]! - key[k]!) / ink))) : c[k]!;
      out.data[i + 3] = Math.round(ink * 255);
    }
  }
}
const file = path.join(dir, 'decals_cut.png');
fs.writeFileSync(file, PNG.sync.write(out));
console.log(`decals_cut.png: ${sheet.decals.length} markings, ${keyed} keyed to their ink, ${(fs.statSync(file).size / 1024).toFixed(0)} KiB`);
