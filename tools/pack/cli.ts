/**
 * tools/pack: build and upload tile packs (ARCHITECTURE 10.4). Run through the heavy gate:
 *
 *   node tools/dev/heavy.mjs --class=bake -- npx tsx tools/pack/cli.ts tiles [--sets=earth,moon]
 *       every baked tile set under data/tiles (or the named ones) into data/packs/<set>/ (incremental)
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/pack/cli.ts files [--sets=sky,assets]
 *       the plain file sets: sky data (data/sky) and public/assets
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/pack/cli.ts boot --build=<client build dir>
 *       the boot pack into data/packs/boot/<hash>.pack; prints its manifest (deploy/boot-manifest.json is
 *       written by `upload --boot`, once the object is in the bucket)
 *   npx tsx tools/pack/cli.ts status            what is packed, sizes, free disk
 *   npx tsx tools/pack/cli.ts prune --sets=x    delete local packs the current index does not name
 *   npx tsx tools/pack/cli.ts upload [--sets=a,b] [--boot=<hash>]    to the packs bucket (PACKS_* from .env)
 *   npx tsx tools/pack/cli.ts verify            every object of deploy/pack-sets.json is in the bucket
 *   npx tsx tools/pack/cli.ts cors              set and read back the bucket's CORS rule
 *
 * Disk: a pack is not written when it would leave less than 25 GB free (PACKAGE_RULES 13d); data/packs is
 * capped at 20 GB in total and the run stops before passing it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bucketFromEnv, s3For } from '../../deploy/packs/bucket';
import { PACK_SETS_FILE, readPackSetsFile } from '../../deploy/packs/packList';
import { setPacksCors, uploadObject, uploadSets, verifySets } from '../../deploy/packs/upload';
import { buildBootPack, type BootConfig, type BootManifest } from './boot';
import { packedSets, packSet, pruneSet } from './packer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(repoRoot, 'data', 'packs');
const MIN_FREE = 25e9;
const PACKS_CAP = 20e9;
const BOOT_MANIFEST = path.join(repoRoot, 'deploy', 'boot-manifest.json');

const [cmd, ...rest] = process.argv.slice(2);
const opts = Object.fromEntries(
  rest.map((a) => {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`bad option ${a}`);
    return [m[1]!, m[2] ?? 'true'];
  }),
);
const log = (line: string): void => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

function loadDotEnv(): void {
  const f = path.join(repoRoot, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}

function freeBytes(dir: string): number {
  fs.mkdirSync(dir, { recursive: true });
  const st = fs.statfsSync(dir);
  return st.bavail * st.bsize;
}

function packsBytes(): number {
  let n = 0;
  for (const s of packedSets(OUT)) {
    for (const f of fs.readdirSync(path.join(OUT, s.set))) if (/\.(pack|idx)$/.test(f)) n += fs.statSync(path.join(OUT, s.set, f)).size;
  }
  return n;
}

const tileSets = (): string[] =>
  fs
    .readdirSync(path.join(repoRoot, 'data', 'tiles'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(repoRoot, 'data', 'tiles', e.name, 'manifest.json')))
    .map((e) => e.name)
    .sort();

const FILE_SETS: Record<string, string> = { sky: 'data/sky', assets: 'public/assets' };

async function main(): Promise<void> {
  switch (cmd) {
    case 'tiles':
    case 'files': {
      const names = opts.sets ? opts.sets.split(',') : cmd === 'tiles' ? tileSets() : Object.keys(FILE_SETS);
      for (const set of names) {
        const used = packsBytes();
        if (used > PACKS_CAP) throw new Error(`data/packs holds ${(used / 1e9).toFixed(1)} GB, over the 20 GB cap: stopped before ${set}`);
        log(`packing ${set}; free ${(freeBytes(OUT) / 1e9).toFixed(1)} GB, data/packs ${(used / 1e9).toFixed(2)} GB`);
        const dir = cmd === 'tiles' ? path.join(repoRoot, 'data', 'tiles', set) : path.join(repoRoot, FILE_SETS[set] ?? set);
        const r = await packSet({ dir, set, type: cmd === 'tiles' ? 'tiles' : 'files', out: OUT, minFreeBytes: MIN_FREE, log });
        console.log(JSON.stringify({ set: r.set, index: r.index, indexBytes: r.indexBytes, packs: r.packs.length, written: r.written.length, groups: r.groups, tiles: r.tiles, files: r.files, bytes: r.bytes, filesRead: r.filesRead, seconds: r.seconds }));
      }
      return;
    }
    case 'boot': {
      if (!opts.build) throw new Error('boot: --build=<client build dir> is required (npm run stack:client writes data/stack/client/<hash>/)');
      const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'deploy', 'boot-pack.json'), 'utf8')) as BootConfig;
      const buildDir = path.resolve(repoRoot, opts.build);
      const m = buildBootPack({ repoRoot, config, buildDir, buildHash: path.basename(buildDir), out: OUT });
      fs.writeFileSync(path.join(OUT, 'boot', `${m.hash}.manifest.json`), `${JSON.stringify(m, null, 1)}\n`);
      console.log(JSON.stringify(m, null, 1));
      return;
    }
    case 'status': {
      for (const s of packedSets(OUT)) console.log(`${s.set.padEnd(14)} ${s.type.padEnd(6)} index ${s.index} packs ${s.packs.length} ${(s.packs.reduce((n, p) => n + p.bytes, 0) / 1e9).toFixed(3)} GB  packed ${s.packedAt}`);
      console.log(`data/packs ${(packsBytes() / 1e9).toFixed(2)} GB; free ${(freeBytes(OUT) / 1e9).toFixed(1)} GB`);
      return;
    }
    case 'prune': {
      for (const set of (opts.sets ?? '').split(',').filter(Boolean)) console.log(set, JSON.stringify(pruneSet(OUT, set)));
      return;
    }
    case 'upload':
    case 'verify':
    case 'cors': {
      loadDotEnv();
      const b = bucketFromEnv('PACKS');
      if (!b) throw new Error('PACKS_BUCKET, PACKS_ENDPOINT, PACKS_REGION, PACKS_ACCESS_KEY_ID and PACKS_SECRET_ACCESS_KEY are needed (the git-ignored .env)');
      const client = s3For(b);
      const setsFile = path.join(repoRoot, PACK_SETS_FILE);
      if (cmd === 'cors') {
        console.log(JSON.stringify(await setPacksCors(client, b)));
        return;
      }
      if (cmd === 'verify') {
        const r = await verifySets(client, b, readPackSetsFile(setsFile));
        console.log(JSON.stringify(r));
        if (r.missing.length > 0) process.exitCode = 1;
        return;
      }
      if (opts.boot) {
        const mf = path.join(OUT, 'boot', `${opts.boot}.manifest.json`);
        const m = JSON.parse(fs.readFileSync(mf, 'utf8')) as BootManifest;
        const r = await uploadObject(client, b, m.hash, path.join(OUT, 'boot', `${m.hash}.pack`));
        log(`boot pack ${r.key} ${(r.bytes / 1e6).toFixed(2)} MB ${r.uploaded ? `uploaded in ${r.seconds.toFixed(1)} s` : 'present'}`);
        fs.writeFileSync(BOOT_MANIFEST, `${JSON.stringify(m, null, 1)}\n`);
      }
      if (opts.sets) {
        const r = await uploadSets({ client, bucket: b, packsDir: OUT, sets: opts.sets.split(','), setsFile, log });
        console.log(JSON.stringify(r));
      }
      return;
    }
    default:
      console.error('usage: tools/pack/cli.ts tiles|files|boot|status|prune|upload|verify|cors [options]  (see the header of this file)');
      process.exitCode = 2;
  }
}

main().catch((e: unknown) => {
  console.error(`pack: ${(e as Error).message}`);
  process.exitCode = 1;
});
