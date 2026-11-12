/**
 * The program entry (ARCHITECTURE 16.1): one Node program, one image, roles selected by configuration.
 *
 *   ROLES=shell            the static front end with the packs mirror (stage 0's `shell` service)
 *   ROLES=game             the combined server process (the hello stand-in in this wave)
 *   ROLES=dump             the cron job: runs once and exits with its result
 *   ROLES=gate | dir | sim-1 | api | pub | packs ...   the processes of the split and launch shapes
 *
 * It starts each named role from the role manifest and hands it the shared services: the logger, the egress
 * meter (one per process), the build identity, the process's HTTP router on PORT and, where the packs
 * credential and a pack-sets source are configured, the pack-list service. /healthz answers 200 only when
 * every role of the process is healthy. Every response that no role meters on a route of its own counts
 * against the `public` egress budget (2 GB a day; then 429 until 00:00 UTC).
 *
 * Stopping: SIGTERM (Railway) drains every role until RAILWAY_DEPLOYMENT_DRAINING_SECONDS from the signal,
 * then exits. Windows cannot deliver SIGTERM to another process, so the local stack sends
 * POST /_ctl/stop with the header x-stack-token equal to STACK_CONTROL_TOKEN instead (only when that
 * variable is set; production never sets it).
 */
import http from 'node:http';
import { isMainThread, workerData } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBuildIdentity } from './buildInfo';
import { bucketFromEnv } from './packs/bucket';
import { createPackListService, mirrorFromEnv, packSetsFromDir, PACK_SETS_FILE, readPackSetsFile, type PackListService } from './packs/packList';
import { EgressMeter, shellBudgetsFromEnv } from './roles/egress';
import { admitPublic, json } from './roles/http';
import { createLogger } from './roles/log';
import { parseRoles, ROLE_MANIFEST } from './roles/manifest';
import type { RoleContext, RoleHandle, RouteHandler } from './roles/types';

const env = process.env;
const self = fileURLToPath(import.meta.url);
const build = readBuildIdentity(self);
// A worker thread started from this bundle (the derating benchmark's) runs its own module, not the roles.
const workerKind = isMainThread ? null : (workerData as { kind?: string } | null)?.kind ?? null;
const roles = workerKind ? [] : parseRoles(env.ROLES);
const log = createLogger({ roles: roles.map((r) => r.name).join(','), build: build.buildId });

function packListService(): PackListService | null {
  const bucket = bucketFromEnv('PACKS', env);
  const mirror = mirrorFromEnv(env);
  const dir = env.PACK_SETS_DIR;
  const file = env.PACK_SETS_FILE ?? (dir ? null : PACK_SETS_FILE);
  if (!bucket && !mirror) return null;
  const sets = dir ? () => packSetsFromDir(dir) : () => readPackSetsFile(path.resolve(file!));
  const order = (env.PACK_MIRROR_ORDER ?? 'bucket,mirror').split(',').map((s) => s.trim()) as ('bucket' | 'mirror')[];
  return createPackListService({ bucket, mirror, order, sets, now: () => Date.now() });
}

async function main(): Promise<void> {
  log.info('start', { node: process.version, pid: process.pid, buildId: build.buildId, commit: build.commit, roles: roles.map((r) => r.name) });
  const egress = new EgressMeter(shellBudgetsFromEnv(env));
  const handlers: RouteHandler[] = [];
  const meteredBy: ((path: string) => boolean)[] = [];
  const modules = await Promise.all(roles.map(async (r) => ({ ...r, mod: (await ROLE_MANIFEST[r.role]!.load()).default })));
  const services = modules.some((m) => m.mod.kind === 'service');
  const port = services ? Number(env.PORT ?? 8080) : null;
  const packList = packListService();
  const handles: { name: string; h: RoleHandle & { done?: Promise<number> } }[] = [];
  for (const m of modules) {
    const ctx: RoleContext = {
      name: m.name,
      env,
      log: log.child({ role: m.name }),
      egress,
      build,
      http: {
        add: (h, opts) => {
          handlers.push(h);
          if (opts?.metered) meteredBy.push(opts.metered);
        },
        port,
      },
      services: { packList },
    };
    handles.push({ name: m.name, h: await m.mod.start(ctx) });
  }

  let stopping = false;
  const stop = async (reason: string, deadlineMs: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info('stop', { reason, deadlineInS: (deadlineMs - Date.now()) / 1000 });
    await Promise.all(handles.map(({ h }) => h.drain(reason, deadlineMs).catch((e: unknown) => log.error('drain-failed', { error: (e as Error).message }))));
    log.info('exit', { reason });
    process.exit(0);
  };

  if (port !== null) {
    const server = http.createServer(async (req, res) => {
      try {
        const p = (req.url ?? '/').split('?')[0]!;
        // Every response no role meters itself counts against the public budget (a hard stop: 429 past it).
        if (!meteredBy.some((f) => f(p)) && !admitPublic(egress, req, res, p)) return;
        if (p === '/healthz') {
          // Public: whether each role is healthy, nothing of its detail (errors stay in the log).
          const parts = handles.map(({ name, h }) => ({ name, ok: h.health().ok }));
          const ok = parts.every((x) => x.ok);
          json(res, ok ? 200 : 503, { ok, buildId: build.buildId, roles: parts });
          return;
        }
        if (p === '/_ctl/stop' && req.method === 'POST' && env.STACK_CONTROL_TOKEN && req.headers['x-stack-token'] === env.STACK_CONTROL_TOKEN) {
          json(res, 202, { stopping: true });
          void stop('control', Date.now() + 2000);
          return;
        }
        for (const h of handlers) if (await h(req, res)) return;
        res.writeHead(404, { 'Content-Length': '0', 'Cache-Control': 'no-store' }).end();
      } catch (e) {
        log.error('request-failed', { url: req.url, error: (e as Error).message });
        if (!res.headersSent) res.writeHead(500, { 'Content-Length': '0' }).end();
        else res.destroy();
      }
    });
    server.keepAliveTimeout = 65_000;
    await new Promise<void>((resolve) => server.listen(port, env.HOST ?? '0.0.0.0', resolve));
    log.info('listening', { port });
  }

  const drainS = Number(env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS ?? 0);
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => void stop(sig, Date.now() + drainS * 1000));

  const jobs = handles.filter(({ h }) => h.done);
  if (!services && jobs.length > 0) {
    const codes = await Promise.all(jobs.map(({ h }) => h.done!.catch((e: unknown) => (log.error('job-failed', { error: (e as Error).message }), 1))));
    const code = codes.find((c) => c !== 0) ?? 0;
    log.info('job-exit', { code });
    process.exit(code);
  }
}

if (workerKind === 'derating-worker') void import('./bench/derating');
else if (workerKind === null) {
  main().catch((e: unknown) => {
    log.error('fatal', { error: (e as Error).message });
    process.exit(1);
  });
}
