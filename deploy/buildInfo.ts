/**
 * Build identity (ARCHITECTURE 16.2). A journal is valid only for the build that wrote it, and at stage 0
 * Railway builds the image itself, so the build computes a `buildId` from the Node image digest and the hash
 * of the server bundle; CI builds the same Dockerfile at the same commit and records its `buildId`, and the
 * rollout refuses a deployment whose `buildId` differs. Every role prints it at start.
 *
 * The image writes build-info.json next to the bundle (deploy/build/stamp.mjs). Outside the image (the
 * local stack's host processes) there is no image digest: the id is `host-<bundle hash>`.
 *
 * What equal buildIds prove, and what they do not: the same Node base image (by digest) and the same server
 * bundle, byte for byte. NOT the client build the shell serves (it has its own id, `clientBuild` in
 * /version.json: the hash of everything the client is built from, tools/dev/build-client.mjs) and not the
 * Debian packages of the runtime stage (pg_dump: pinned by version in deploy/Dockerfile). A rollout compares
 * buildId AND clientBuild.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BuildIdentity } from './roles/types';

export function computeBuildId(nodeImageDigest: string, bundleHash: string): string {
  return createHash('sha256').update(`${nodeImageDigest}\n${bundleHash}`).digest('hex').slice(0, 16);
}

/** The identity of the running bundle: build-info.json beside it, else computed from the bundle file. */
export function readBuildIdentity(bundleFile: string): BuildIdentity {
  const info = path.join(path.dirname(bundleFile), 'build-info.json');
  if (fs.existsSync(info)) {
    const j = JSON.parse(fs.readFileSync(info, 'utf8')) as BuildIdentity;
    if (j.nodeImageDigest && j.bundleHash && j.buildId !== computeBuildId(j.nodeImageDigest, j.bundleHash)) throw new Error(`${info}: buildId does not match its digest and bundle hash`);
    return j;
  }
  const bundleHash = fs.existsSync(bundleFile) && bundleFile.endsWith('.mjs') ? createHash('sha256').update(fs.readFileSync(bundleFile)).digest('hex').slice(0, 16) : null;
  return { buildId: `host-${bundleHash ?? 'source'}`, nodeImageDigest: null, bundleHash, commit: null };
}
