/**
 * Bake one render tile exactly as a terrain worker does (fs tile source) and report its completeness and
 * timing:  npx tsx tools/terrain/probe-bake.ts <body> <face>/<level>/<x>/<y> [residentLevel] [cacheMiB]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fsDefSource } from '../../src/core/defs/fsSource';
import { loadDefs } from '../../src/core/defs/loader';
import { parseTileKey } from '../../src/core/geo/cubeSphere';
import { createTerrainProvider } from '../../src/terrain';
import { createFsTileSource } from '../../src/terrain/fsTileSource';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main(): Promise<void> {
  const [bodyId = 'earth', keyText = '1/14/11905/11287', resident = '2', cache = '96'] = process.argv.slice(2);
  const defs = await loadDefs(fsDefSource(path.join(repoRoot, 'data', 'defs')));
  const provider = await createTerrainProvider(defs, createFsTileSource(path.join(repoRoot, 'data', 'tiles')), {
    bodies: [bodyId],
    residentLevel: Number(resident),
    cacheBytes: Number(cache) * 1024 * 1024,
  });
  const key = parseTileKey(keyText);
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    await provider.prepareTile(bodyId, key, 'render');
    const t1 = performance.now();
    const bake = provider.bakeTile(bodyId, key);
    const t2 = performance.now();
    console.log(
      `${bodyId} ${keyText}: geometry complete ${bake.geometry.complete}, normal complete ${bake.normalMaterial.complete}, h ${bake.geometry.hMin.toFixed(2)}..${bake.geometry.hMax.toFixed(2)} m, ` +
        `slopeScale ${bake.normalMaterial.slopeScale.toFixed(3)}, prepare ${(t1 - t0).toFixed(1)} ms, bake ${(t2 - t1).toFixed(1)} ms, cache ${JSON.stringify(provider.diagnostics().cache)}`,
    );
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
