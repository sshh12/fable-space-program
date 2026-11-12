/**
 * The corpus of vessel blobs (docs/ARCHITECTURE.md 7.2: "CI keeps a corpus of blobs written by every
 * released build and proves each still decodes"). Each entry is a scene of ../codecScenes.ts written by one
 * codec version: `<scene>.v<version>.bin`, listed in corpus.json with the state hash the vessel had when it
 * was written. ../codec.test.ts decodes every entry and compares the hash.
 *
 * This script ADDS entries that are missing (a new scene, or the entries of a new codec version after the
 * version constant was raised); it never rewrites one: a blob in the corpus is what an earlier build wrote.
 *
 *   npx tsx tests/unit/sim-vessel/codec-corpus/record.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEC_VERSION, contentHash, encodeVessel, libraryResolver, stateHash } from '@/sim/vessel';
import { buildScene, SCENE_NAMES } from '../codecScenes';
import { loadLibrary } from '../helpers';

export interface CorpusEntry {
  file: string;
  scene: string;
  version: number;
  /** Library hash in the blob's header, bytes of the blob, and the state hash of the vessel that was written. */
  defsHash: string;
  bytes: number;
  parts: number;
  stateHash: string;
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const listFile = path.join(dir, 'corpus.json');
const defs = await loadLibrary();
const refs = libraryResolver(defs);
const defsHash = contentHash({ parts: defs.parts, vehicles: defs.vehicles });
const list: CorpusEntry[] = fs.existsSync(listFile) ? (JSON.parse(fs.readFileSync(listFile, 'utf8')) as CorpusEntry[]) : [];
// Version 1 is in the corpus from the day version 2 replaced it; later versions are added as they are written.
const versions = process.argv.includes('--with-version-1') ? [1, CODEC_VERSION] : [CODEC_VERSION];
for (const scene of SCENE_NAMES) {
  for (const version of versions) {
    const file = `${scene}.v${version}.bin`;
    if (list.some((e) => e.file === file)) {
      console.log(`${file}: in the corpus, left alone`);
      continue;
    }
    const s = buildScene(defs, scene);
    const bytes = encodeVessel(s.vessel, { defsHash, refs, version });
    fs.writeFileSync(path.join(dir, file), bytes);
    list.push({ file, scene, version, defsHash, bytes: bytes.length, parts: s.vessel.parts.length, stateHash: stateHash(s.vessel) });
    console.log(`${file}: ${bytes.length} bytes, ${s.vessel.parts.length} parts, state ${stateHash(s.vessel)}`);
  }
}
fs.writeFileSync(listFile, `${JSON.stringify(list, null, 1)}\n`);
