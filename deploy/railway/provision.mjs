#!/usr/bin/env node
/**
 * Stage 0 on Railway's Hobby plan (ARCHITECTURE 16.2), with the logged-in CLI: idempotent, so it is also the
 * runbook. The project `fable-space-program` (environment production) and its buckets `packs` and `dumps`
 * exist (created by `railway init` and `railway bucket create`, see docs/handoff/platform-delivery.md).
 *
 *   node deploy/railway/provision.mjs services     create postgres, game, shell, dump with their settings,
 *                                                   limits, volume, variables (secrets passed on stdin to the
 *                                                   API, never on a command line or in a log), domains, CDN
 *   node deploy/railway/provision.mjs deploy <svc>  upload a clean export of HEAD (git archive: tracked files
 *                                                   only, never .env or data/) and build deploy/Dockerfile;
 *                                                   the documented fallback while the GitHub App has no access
 *                                                   (OPEN_QUESTIONS Q5)
 *   node deploy/railway/provision.mjs ids           print the project, environment and service ids
 *   node deploy/railway/provision.mjs ops <role>    run an operator job role once in a temporary service `ops`
 *                                                   (pgsettings: ALTER SYSTEM to production's values;
 *                                                   derating: the D7 benchmark at 8 vCPU / 8 GB)
 *   node deploy/railway/provision.mjs ops-delete    delete the temporary service
 *
 * Nothing here touches another project: every call names the project id below.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PROJECT = '7cc16fa5-1790-44e6-8087-4e75673a5a7a';
export const ENVIRONMENT = '11958a85-d81f-4639-9d77-90bbef65e27b';
const REGION = 'us-east4-eqdc4a';
const PG_IMAGE = 'ghcr.io/railwayapp-templates/postgres-ssl:18';
const INITDB_ARGS = '--encoding=UTF8 --locale-provider=builtin --builtin-locale=C.UTF-8';

/** The CLI binary: RAILWAY_BIN, else the executable behind npm's shim on Windows, else `railway` on PATH. */
function railwayBin() {
  if (process.env.RAILWAY_BIN) return process.env.RAILWAY_BIN;
  if (process.platform === 'win32' && process.env.APPDATA) {
    const exe = path.join(process.env.APPDATA, 'npm', 'node_modules', '@railway', 'cli', 'bin', 'railway.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return 'railway';
}
const RAILWAY = railwayBin();

export function rw(args, input, cwd = REPO) {
  const r = spawnSync(RAILWAY, args, { cwd, encoding: 'utf8', input, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`railway ${args.filter((a) => !a.includes('=')).join(' ')}: ${[r.stdout, r.stderr, r.error ? String(r.error) : ""].join(" ").trim().slice(0, 2000)}`);
  return r.stdout;
}

/** A GraphQL call through `railway api`; variables travel on stdin. */
export function gql(query, variables = {}) {
  const out = rw(['api', query.replace(/\s+/g, ' '), '--variables', '@-'], JSON.stringify(variables));
  const j = JSON.parse(out);
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

export function services() {
  const d = gql(`query($p:String!){ project(id:$p){ services { edges { node { id name } } } } }`, { p: PROJECT });
  return Object.fromEntries(d.project.services.edges.map((e) => [e.node.name, e.node.id]));
}

function ensureService(name) {
  const have = services();
  if (have[name]) return have[name];
  const d = gql(`mutation($i:ServiceCreateInput!){ serviceCreate(input:$i){ id name } }`, { i: { projectId: PROJECT, name } });
  console.log(`created service ${name} ${d.serviceCreate.id}`);
  return d.serviceCreate.id;
}

function update(serviceId, input) {
  gql(`mutation($s:String!,$e:String!,$i:ServiceInstanceUpdateInput!){ serviceInstanceUpdate(serviceId:$s, environmentId:$e, input:$i) }`, { s: serviceId, e: ENVIRONMENT, i: input });
}

function limits(serviceId, vCPUs, memoryGB) {
  gql(`mutation($i:ServiceInstanceLimitsUpdateInput!){ serviceInstanceLimitsUpdate(input:$i) }`, { i: { environmentId: ENVIRONMENT, serviceId, vCPUs, memoryGB } });
}

export function setVars(serviceId, variables) {
  gql(`mutation($i:VariableCollectionUpsertInput!){ variableCollectionUpsert(input:$i) }`, { i: { projectId: PROJECT, environmentId: ENVIRONMENT, serviceId, variables, skipDeploys: true } });
}

function varsOf(serviceId) {
  return gql(`query($p:String!,$e:String!,$s:String!){ variables(projectId:$p, environmentId:$e, serviceId:$s) }`, { p: PROJECT, e: ENVIRONMENT, s: serviceId }).variables;
}

export function bucketCreds(name) {
  return JSON.parse(rw(['bucket', 'credentials', '--bucket', name, '--json']));
}

function domainOf(serviceId, name) {
  const d = gql(`query($p:String!,$e:String!,$s:String!){ domains(projectId:$p, environmentId:$e, serviceId:$s){ serviceDomains { domain } } }`, { p: PROJECT, e: ENVIRONMENT, s: serviceId });
  if (d.domains.serviceDomains.length > 0) return d.domains.serviceDomains[0].domain;
  const c = gql(`mutation($i:ServiceDomainCreateInput!){ serviceDomainCreate(input:$i){ domain } }`, { i: { environmentId: ENVIRONMENT, serviceId, targetPort: 8080 } });
  console.log(`domain for ${name}: ${c.serviceDomainCreate.domain}`);
  return c.serviceDomainCreate.domain;
}

const bucketVars = (prefix, c) => ({
  [`${prefix}_BUCKET`]: c.bucketName,
  [`${prefix}_ENDPOINT`]: c.endpoint,
  [`${prefix}_REGION`]: c.region,
  [`${prefix}_ACCESS_KEY_ID`]: c.accessKeyId,
  [`${prefix}_SECRET_ACCESS_KEY`]: c.secretAccessKey,
  [`${prefix}_PATH_STYLE`]: c.urlStyle === 'path' ? '1' : '0',
});

function provisionServices() {
  const region = { multiRegionConfig: { [REGION]: { numReplicas: 1 } } };
  // postgres: the template's image at major 18, its volume, the cluster settings BEFORE the first boot.
  const pgId = ensureService('postgres');
  const pgVars = varsOf(pgId);
  if (!pgVars.POSTGRES_PASSWORD) {
    setVars(pgId, {
      POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
      POSTGRES_DB: 'railway',
      PGDATA: '/var/lib/postgresql/data/pgdata',
      PGPORT: '5432',
      POSTGRES_INITDB_ARGS: INITDB_ARGS,
      SSL_CERT_DAYS: '820',
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '60',
      DATABASE_URL: 'postgresql://${{POSTGRES_USER}}:${{POSTGRES_PASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:5432/${{POSTGRES_DB}}',
    });
    console.log('postgres: variables set (password generated inside Railway; POSTGRES_INITDB_ARGS before the first boot)');
  }
  const vols = gql(`query($p:String!){ project(id:$p){ volumes { edges { node { id name volumeInstances { edges { node { serviceId mountPath } } } } } } } }`, { p: PROJECT });
  const hasVol = vols.project.volumes.edges.some((e) => e.node.volumeInstances.edges.some((v) => v.node.serviceId === pgId));
  if (!hasVol) {
    gql(`mutation($i:VolumeCreateInput!){ volumeCreate(input:$i){ id } }`, { i: { projectId: PROJECT, environmentId: ENVIRONMENT, serviceId: pgId, mountPath: '/var/lib/postgresql/data' } });
    console.log('postgres: volume created at /var/lib/postgresql/data');
  }
  update(pgId, { ...region, restartPolicyType: 'ALWAYS', source: { image: PG_IMAGE } });
  limits(pgId, 1, 0.5);

  // game: the hello stand-in until wave 5; built by Railway from the Dockerfile; autodeploy off (no repo source).
  const gameId = ensureService('game');
  update(gameId, { ...region, dockerfilePath: 'deploy/Dockerfile', healthcheckPath: '/healthz', healthcheckTimeout: 120, drainingSeconds: 45, restartPolicyType: 'ALWAYS' });
  limits(gameId, 2, 2);
  const shellId = ensureService('shell');
  update(shellId, { ...region, dockerfilePath: 'deploy/Dockerfile', healthcheckPath: '/healthz', healthcheckTimeout: 120, restartPolicyType: 'ALWAYS', watchPatterns: ['src/**', 'public/**', 'index.html', 'data/defs/**', 'deploy/roles/shell.ts', 'deploy/roles/packs.ts', 'deploy/boot-manifest.json'] });
  limits(shellId, 0.5, 0.25);
  const dumpId = ensureService('dump');
  update(dumpId, { ...region, dockerfilePath: 'deploy/Dockerfile', cronSchedule: '7 * * * *', restartPolicyType: 'NEVER' });
  limits(dumpId, 1, 0.5);

  const gameDomain = domainOf(gameId, 'game');
  const shellDomain = domainOf(shellId, 'shell');
  const packs = bucketCreds('packs');
  const dumps = bucketCreds('dumps');
  setVars(gameId, {
    ROLES: 'game',
    PORT: '8080',
    DATABASE_URL: '${{postgres.DATABASE_URL}}',
    RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '45',
    ADMISSION_CAP: '20',
    MIRROR_BASE: `https://${shellDomain}/p/`,
    MIRROR_MODE: 'slices',
    // The one source of truth of the slice size: the pack list states it and slice URLs carry it (/p/<hash>/<S>/<n>).
    MIRROR_SLICE_BYTES: String(256 * 1024),
    ...bucketVars('PACKS', packs),
  });
  setVars(shellId, {
    ROLES: 'shell',
    PORT: '8080',
    ENDPOINT_GATE: `https://${gameDomain}`,
    ENDPOINT_API: `https://${gameDomain}`,
    ENDPOINT_PUB: `https://${gameDomain}`,
    ...bucketVars('PACKS', packs),
  });
  setVars(dumpId, { ROLES: 'dump', DATABASE_URL: '${{postgres.DATABASE_URL}}', DUMP_BUDGET_BYTES_PER_DAY: '1500000000', ...bucketVars('DUMPS', dumps) });
  console.log(`variables set: game (packs credential), shell (packs credential), dump (dumps credential only)`);
  console.log(JSON.stringify({ postgres: pgId, game: gameId, shell: shellId, dump: dumpId, gameDomain, shellDomain }));
}

/** Upload a clean export of HEAD (tracked files only) and build it as `service`. */
function deploy(service) {
  if (!service) throw new Error('deploy <service>');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsp-export-'));
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  const src = path.join(dir, 'src');
  fs.mkdirSync(src);
  const tar = path.join(src, 'export.tar');
  const a = spawnSync('git', ['archive', '--format=tar', '-o', tar, 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  if (a.status !== 0) throw new Error(a.stderr);
  // A relative archive name inside the target: GNU tar reads "C:..." as a remote host.
  const x = spawnSync('tar', ['-xf', 'export.tar'], { cwd: src, encoding: 'utf8' });
  if (x.status !== 0) throw new Error(x.stderr);
  fs.rmSync(tar);
  const ids = services();
  setVars(ids[service], { RAILWAY_DOCKERFILE_PATH: 'deploy/Dockerfile', COMMIT: commit });
  const t0 = Date.now();
  // Run from inside the export: the CLI resolves its upload root from the working directory.
  const out = rw(['up', '--service', service, '--environment', 'production', '--project', PROJECT, '--detach', '--no-gitignore'], undefined, src);
  console.log(out.trim());
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify({ service, commit, uploadedS: (Date.now() - t0) / 1000 }));
}

/**
 * A one-off operator job inside the private network: a temporary service `ops` (no cron, restart Never) runs
 * ROLES=<role> once from a clean export with the database URL as a reference variable, then is deleted.
 */
function opsJob(role) {
  const id = ensureService('ops');
  update(id, { multiRegionConfig: { [REGION]: { numReplicas: 1 } }, dockerfilePath: 'deploy/Dockerfile', restartPolicyType: 'NEVER' });
  // The derating benchmark (D7) runs at the largest Hobby replica, 8 vCPU / 8 GB, for the minutes it takes;
  // the service is deleted afterwards (ops-delete), so nothing stays at that size.
  const bench = role === 'derating';
  limits(id, bench ? 8 : 1, bench ? 8 : 0.5);
  const gameDomain = domainOf(services().game, 'game');
  setVars(id, { ROLES: role, DATABASE_URL: '${{postgres.DATABASE_URL}}', ...(bench ? { BENCH_PACK_LIST: `https://${gameDomain}/packs.json`, BENCH_DEFS_DIR: '/app/client/defs', BENCH_WORKERS: '1,2,4,8', BENCH_SECONDS: '30', BENCH_IDLE_S: '20' } : {}) });
  deploy('ops');
  console.log(`ops: deployed ROLES=${role}; read its log with: railway logs --service ops, then: node deploy/railway/provision.mjs ops-delete`);
}

function opsDelete() {
  const id = services().ops;
  if (!id) return console.log('ops: no such service');
  gql(`mutation($s:String!){ serviceDelete(id:$s) }`, { s: id });
  console.log(`ops: service ${id} deleted`);
}

/**
 * The secret variables, sealed (irreversible): a sealed value reaches builds and deployments but never the
 * UI, the API or the CLI again. POSTGRES_PASSWORD is referenced by postgres's DATABASE_URL, which game, dump
 * and the ops jobs reference in turn; it is sealed only after a deployment proved that a reference to a sealed
 * variable resolves (`seal-probe`, platform-delivery hand-off).
 */
const SEALED = { game: ['PACKS_SECRET_ACCESS_KEY'], shell: ['PACKS_SECRET_ACCESS_KEY'], dump: ['DUMPS_SECRET_ACCESS_KEY'], postgres: ['POSTGRES_PASSWORD'] };

/** Which secret variables are sealed (names only). */
export function sealState() {
  const ids = services();
  const byId = Object.fromEntries(Object.entries(ids).map(([n, id]) => [id, n]));
  const d = gql('query($id:String!){ environment(id:$id){ variables(first:500){ edges{ node{ name isSealed serviceId } } } } }', { id: ENVIRONMENT });
  return d.environment.variables.edges
    .map((e) => e.node)
    .filter((n) => /SECRET|PASSWORD/.test(n.name))
    .map((n) => ({ service: byId[n.serviceId] ?? n.serviceId, name: n.name, sealed: n.isSealed }));
}

function seal(only) {
  const ids = services();
  const patch = {};
  for (const [svc, names] of Object.entries(SEALED)) {
    if (only && !only.split(',').includes(svc)) continue;
    patch[ids[svc]] = { variables: Object.fromEntries(names.map((n) => [n, { isSealed: true }])) };
  }
  gql('mutation($e:String!,$p:EnvironmentConfig!){ environmentPatchCommit(environmentId:$e, patch:$p, skipDeploys:true, commitMessage:"seal secret variables") }', { e: ENVIRONMENT, p: { services: patch } });
  for (const v of sealState()) console.log(`${v.service.padEnd(9)} ${v.name.padEnd(28)} ${v.sealed ? 'sealed' : 'NOT sealed'}`);
}

/** The three latest deployments of a service: id, status, created, the COMMIT variable it was built with. */
function deployStatus(service) {
  const ids = services();
  if (!ids[service]) throw new Error(`no service ${service}`);
  const d = gql(
    'query($s:String!,$e:String!){ deployments(first:3, input:{serviceId:$s, environmentId:$e}){ edges{ node{ id status createdAt } } } }',
    { s: ids[service], e: ENVIRONMENT },
  );
  for (const e of d.deployments.edges) console.log(JSON.stringify(e.node));
}

// Run as a program; imported (deploy/railway/rotate-dumps.mjs), it only lends its helpers.
const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const [cmd, arg] = isMain ? process.argv.slice(2) : ['(imported)'];
if (!isMain) {
  // nothing to run
} else if (cmd === 'ops') opsJob(arg ?? 'pgsettings');
else if (cmd === 'ops-delete') opsDelete();
else if (cmd === 'services') provisionServices();
else if (cmd === 'deploy') deploy(arg);
else if (cmd === 'status') deployStatus(arg);
else if (cmd === 'seal') seal(arg);
else if (cmd === 'seal-state') for (const v of sealState()) console.log(`${v.service.padEnd(9)} ${v.name.padEnd(28)} ${v.sealed ? 'sealed' : 'NOT sealed'}`);
else if (cmd === 'ids') console.log(JSON.stringify({ project: PROJECT, environment: ENVIRONMENT, services: services() }));
else {
  console.error('usage: node deploy/railway/provision.mjs services | deploy <service> | status <service> | ids | ops <role> | ops-delete');
  process.exit(2);
}
