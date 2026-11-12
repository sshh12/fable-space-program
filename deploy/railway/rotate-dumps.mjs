#!/usr/bin/env node
/**
 * Rotates the dumps bucket's credential (ARCHITECTURE 16.2, "Secrets"), printing no value:
 *
 *   1. `railway bucket credentials --bucket dumps --reset`: a new key pair; the old one stops working;
 *   2. the dump service's DUMPS_ACCESS_KEY_ID and DUMPS_SECRET_ACCESS_KEY are set to it (no redeploy: the cron
 *      job reads them at its next run), and the secret is sealed;
 *   3. the Modal secret fsp-dumps (environment fsp) is written again from it (deploy/modal/secret-from-bucket.mjs:
 *      through the Modal SDK on stdin, no file, no command line);
 *   4. the Modal app fsp-offsite is deployed again: a deployed app holds the secret it was deployed with (by
 *      object, not by name), so after the secret is replaced its functions cannot start until it is redeployed
 *      (found 2026-11-12: copy_dump calls queued and never ran).
 * The credential lives in this process's memory only. Nothing else holds the dumps credential (.env has the
 * packs credential alone).
 *
 *   node deploy/railway/rotate-dumps.mjs
 */
import { spawnSync } from 'node:child_process';
import { writeModalSecret } from '../modal/secret-from-bucket.mjs';
import { ENVIRONMENT, gql, rw, sealState, services, setVars } from './provision.mjs';

const ids = services();
if (!ids.dump) throw new Error('no dump service');
const c = JSON.parse(rw(['bucket', 'credentials', '--bucket', 'dumps', '--reset', '--yes', '--json']));
if (!c.accessKeyId || !c.secretAccessKey) throw new Error('the reset returned no key pair');
console.log('rotate-dumps: the dumps bucket has a new key pair (the old one is revoked)');
setVars(ids.dump, { DUMPS_ACCESS_KEY_ID: c.accessKeyId, DUMPS_SECRET_ACCESS_KEY: c.secretAccessKey });
gql('mutation($e:String!,$p:EnvironmentConfig!){ environmentPatchCommit(environmentId:$e, patch:$p, skipDeploys:true, commitMessage:"seal the rotated dumps secret") }', {
  e: ENVIRONMENT,
  p: { services: { [ids.dump]: { variables: { DUMPS_SECRET_ACCESS_KEY: { isSealed: true } } } } },
});
// The API shows a seal a moment after the commit: asked again for up to 10 s.
let sealed = false;
for (let i = 0; i < 10 && !sealed; i++) {
  if (i > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  sealed = sealState().find((v) => v.service === 'dump' && v.name === 'DUMPS_SECRET_ACCESS_KEY')?.sealed ?? false;
}
console.log(`rotate-dumps: dump service variables set; DUMPS_SECRET_ACCESS_KEY ${sealed ? 'sealed' : 'NOT sealed'}`);
const keys = writeModalSecret('fsp-dumps', 'DUMPS', c);
console.log(`rotate-dumps: Modal secret fsp-dumps (environment fsp) written again: ${keys.join(', ')}`);
const d = spawnSync('modal', ['deploy', '--env', 'fsp', 'deploy/modal/fsp_offsite.py'], { encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
if (d.status !== 0) throw new Error(`modal deploy fsp-offsite failed (exit ${d.status}): run it by hand before the next 04:17 UTC copy`);
console.log('rotate-dumps: Modal app fsp-offsite deployed again with the new secret');
