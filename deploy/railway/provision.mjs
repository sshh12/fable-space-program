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

function rw(args, input) {
  const r = spawnSync(RAILWAY, args, { cwd: REPO, encoding: 'utf8', input, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`railway ${args.filter((a) => !a.includes('=')).join(' ')}: ${(r.stderr || r.stdout || String(r.error)).trim()}`);
  return r.stdout;
}

/** A GraphQL call through `railway api`; variables travel on stdin. */
export function gql(query, variables = {}) {
  const out = rw(['api', query.replace(/\s+/g, ' '), '--variables', '@-'], JSON.stringify(variables));
  const j = JSON.parse(out);
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

function services() {
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

function setVars(serviceId, variables) {
  gql(`mutation($i:VariableCollectionUpsertInput!){ variableCollectionUpsert(input:$i) }`, { i: { projectId: PROJECT, environmentId: ENVIRONMENT, serviceId, variables, skipDeploys: true } });
}

function varsOf(serviceId) {
  return gql(`query($p:String!,$e:String!,$s:String!){ variables(projectId:$p, environmentId:$e, serviceId:$s) }`, { p: PROJECT, e: ENVIRONMENT, s: serviceId }).variables;
}

function bucketCreds(name) {
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
  update(gameId, { ...region, builder: 'DOCKERFILE', dockerfilePath: 'deploy/Dockerfile', healthcheckPath: '/healthz', healthcheckTimeout: 120, drainingSeconds: 45, restartPolicyType: 'ALWAYS' });
  limits(gameId, 2, 2);
  const shellId = ensureService('shell');
  update(shellId, { ...region, builder: 'DOCKERFILE', dockerfilePath: 'deploy/Dockerfile', healthcheckPath: '/healthz', healthcheckTimeout: 120, restartPolicyType: 'ALWAYS', watchPatterns: ['src/**', 'public/**', 'index.html', 'data/defs/**', 'deploy/roles/shell.ts', 'deploy/roles/packs.ts', 'deploy/boot-manifest.json'] });
  limits(shellId, 0.5, 0.25);
  const dumpId = ensureService('dump');
  update(dumpId, { ...region, builder: 'DOCKERFILE', dockerfilePath: 'deploy/Dockerfile', cronSchedule: '7 * * * *', restartPolicyType: 'NEVER' });
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
    MIRROR_SLICE_BYTES: String(2 * 1024 * 1024),
    ...bucketVars('PACKS', packs),
  });
  setVars(shellId, {
    ROLES: 'shell',
    PORT: '8080',
    ENDPOINT_GATE: `https://${gameDomain}`,
    ENDPOINT_API: `https://${gameDomain}`,
    ENDPOINT_PUB: `https://${gameDomain}`,
    MIRROR_SLICE_BYTES: String(2 * 1024 * 1024),
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
  const tar = path.join(dir, 'export.tar');
  const a = spawnSync('git', ['archive', '--format=tar', '-o', tar, 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  if (a.status !== 0) throw new Error(a.stderr);
  const src = path.join(dir, 'src');
  fs.mkdirSync(src);
  const x = spawnSync('tar', ['-xf', tar, '-C', src], { encoding: 'utf8' });
  if (x.status !== 0) throw new Error(x.stderr);
  fs.rmSync(tar);
  const ids = services();
  setVars(ids[service], { RAILWAY_DOCKERFILE_PATH: 'deploy/Dockerfile', COMMIT: commit });
  const t0 = Date.now();
  const out = rw(['up', src, '--service', service, '--environment', 'production', '--project', PROJECT, '--detach', '--no-gitignore']);
  console.log(out.trim());
  console.log(JSON.stringify({ service, commit, uploadedS: (Date.now() - t0) / 1000, export: src }));
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'services') provisionServices();
else if (cmd === 'deploy') deploy(arg);
else if (cmd === 'ids') console.log(JSON.stringify({ project: PROJECT, environment: ENVIRONMENT, services: services() }));
else {
  console.error('usage: node deploy/railway/provision.mjs services | deploy <service> | ids');
  process.exit(2);
}
