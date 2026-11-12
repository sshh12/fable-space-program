/**
 * The pack list (ARCHITECTURE 10.4; format `PackList` in src/terrain/packIndex.ts): what a client reads from
 * `TileSourceSpec.packListUrl`. A shared service of the program entry, handed to the role that answers
 * `/packs.json` (the hello stand-in for `game` in this wave, the `api` role of server/ from wave 5).
 *
 * - The bucket mirror: one presigned GET URL per object (every pack and index of every set), signed with the
 *   date quantised to the UTC day and the presigner's longest lifetime (7 days). Every client gets the same
 *   URLs for a day, and a URL handed out at any moment of that day is good for at least six more days.
 * - The `packs` mirror (inside `shell` up to stage 2): `base` + hash in `ranges` mode, or + `/<n>` in `slices`
 *   mode with `sliceBytes`. The mode and the slice size are configuration (MIRROR_MODE, MIRROR_SLICE_BYTES),
 *   chosen by the measurement of ARCHITECTURE 10.4, never compiled into the client.
 * - The sets come from `deploy/pack-sets.json` (tracked; written by the upload tool: what is in the bucket)
 *   or, on the local stack, from the packer's `data/packs/<set>/current.json` pointers.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { S3Client } from '@aws-sdk/client-s3';
import { PACK_FORMAT_VERSION, type PackList, type PackListMirror, type PackRef } from '../../src/terrain/packIndex';
import { packKey, presignGet, s3For, utcDay, type BucketConfig } from './bucket';

export interface PackSetEntry {
  type: 'tiles' | 'files';
  index: string;
  indexBytes: number;
  packs: PackRef[];
  contentHash: string | null;
}

/** deploy/pack-sets.json: the sets uploaded to the packs bucket. */
export interface PackSetsDoc {
  v: 1;
  uploadedAt: string;
  sets: Record<string, PackSetEntry>;
}

export const PACK_SETS_FILE = 'deploy/pack-sets.json';

export function readPackSetsFile(file: string): PackSetsDoc {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as PackSetsDoc;
  if (doc.v !== 1 || typeof doc.sets !== 'object') throw new Error(`${file}: not a pack-sets document`);
  return doc;
}

/** The sets of a local data/packs directory (the packer's current.json pointers). */
export function packSetsFromDir(packsDir: string): PackSetsDoc {
  const sets: Record<string, PackSetEntry> = {};
  if (fs.existsSync(packsDir)) {
    for (const e of fs.readdirSync(packsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const f = path.join(packsDir, e.name, 'current.json');
      if (!fs.existsSync(f)) continue;
      const c = JSON.parse(fs.readFileSync(f, 'utf8')) as PackSetEntry & { set: string };
      sets[c.set] = { type: c.type, index: c.index, indexBytes: c.indexBytes, packs: c.packs, contentHash: c.contentHash };
    }
  }
  return { v: 1, uploadedAt: 'local', sets };
}

export interface MirrorConfig {
  /** Absolute or relative URL ending in `/p/`. */
  base: string;
  mode: 'ranges' | 'slices';
  sliceBytes: number;
}

export interface PackListOptions {
  /** The packs bucket (its credential signs the URLs); null leaves the bucket out of the list. */
  bucket: BucketConfig | null;
  mirror: MirrorConfig | null;
  /** Mirror order; ARCHITECTURE 10.4 puts the bucket first. */
  order: ('bucket' | 'mirror')[];
  sets: () => PackSetsDoc;
  now: () => number;
  /** Seconds after which a client fetches the list again. Default one day. */
  refreshAfterS?: number;
  /** A client for the bucket (tests inject one; default built from `bucket`). */
  client?: S3Client;
}

export interface PackListService {
  /** The list for the current UTC day (signed once per day and per sets document). */
  get(): Promise<PackList>;
}

export function createPackListService(o: PackListOptions): PackListService {
  const client = o.bucket ? (o.client ?? s3For(o.bucket)) : null;
  let cached: { day: string; setsKey: string; list: Promise<PackList> } | null = null;
  return {
    get() {
      const now = o.now();
      const day = utcDay(now);
      const sets = o.sets();
      const setsKey = JSON.stringify(Object.entries(sets.sets).map(([k, v]) => [k, v.index]));
      if (cached && cached.day === day && cached.setsKey === setsKey) return cached.list;
      const list = (async (): Promise<PackList> => {
        const mirrors: PackListMirror[] = [];
        for (const which of o.order) {
          if (which === 'bucket' && o.bucket && client) {
            const objects: Record<string, string> = {};
            const hashes = new Set<string>();
            for (const s of Object.values(sets.sets)) {
              hashes.add(s.index);
              for (const p of s.packs) hashes.add(p.hash);
            }
            for (const h of [...hashes].sort()) objects[h] = await presignGet(client, o.bucket, packKey(h), now);
            mirrors.push({ id: 'bucket', mode: 'ranges', objects });
          } else if (which === 'mirror' && o.mirror) {
            mirrors.push(o.mirror.mode === 'slices' ? { id: 'mirror', mode: 'slices', base: o.mirror.base, sliceBytes: o.mirror.sliceBytes } : { id: 'mirror', mode: 'ranges', base: o.mirror.base });
          }
        }
        if (mirrors.length === 0) throw new Error('pack list: no mirror is configured (no packs bucket credential and no mirror base)');
        return {
          v: PACK_FORMAT_VERSION,
          signedDay: o.bucket ? day : null,
          refreshAfterS: o.refreshAfterS ?? 86400,
          mirrors,
          sets: Object.fromEntries(Object.entries(sets.sets).map(([k, v]) => [k, { index: v.index, indexBytes: v.indexBytes }])),
        };
      })();
      list.catch(() => {
        if (cached?.list === list) cached = null;
      });
      cached = { day, setsKey, list };
      return list;
    },
  };
}

/** Mirror settings from the environment: MIRROR_BASE, MIRROR_MODE (ranges | slices), MIRROR_SLICE_BYTES. */
export function mirrorFromEnv(env: Record<string, string | undefined> = process.env): MirrorConfig | null {
  if (!env.MIRROR_BASE) return null;
  const mode = env.MIRROR_MODE ?? 'slices';
  if (mode !== 'ranges' && mode !== 'slices') throw new Error(`MIRROR_MODE must be ranges or slices, not ${mode}`);
  const sliceBytes = Number(env.MIRROR_SLICE_BYTES ?? 2 * 1024 * 1024);
  if (!(sliceBytes > 0)) throw new Error('MIRROR_SLICE_BYTES must be positive');
  return { base: env.MIRROR_BASE, mode, sliceBytes };
}
