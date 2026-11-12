/**
 * The hello role: what stands where each server role (game, gate, dir, sim, api, pub) will be until
 * server-persistence puts the real ones into the role manifest in wave 5. It is what the stage-0 skeleton
 * measures with (ARCHITECTURE 16.2; hosting-small section 9):
 *
 *   /healthz      passes at once: a role in standby is healthy (the deploy overlap depends on it)
 *   /hello        role, build, an opaque per-process instance tag (random at start), uptime, draining,
 *                 whether the database is connected and its outage count: which process a request reached
 *                 during a deploy overlap. Public, so nothing of the platform (no deployment or replica id, no
 *                 pid) and no error text (errors go to the log)
 *   /packs.json   the pack list (deploy/packs/packList.ts), where the program entry configured the service,
 *                 gzip-encoded for a client that accepts it; `api` serves it from wave 5
 *   Every response counts against the public egress budget of the program entry (deploy/main.ts).
 *   database      with DATABASE_URL: one connection, `select 1` every second; a lost connection is logged
 *                 with its time and the reconnection with the outage (the Postgres-restart measurement);
 *                 the cluster's major, encoding and locale provider are logged at every connect
 *   drain         SIGTERM is logged with its time; the role then logs a heartbeat every second until the
 *                 deadline the platform announced (RAILWAY_DEPLOYMENT_DRAINING_SECONDS) plus 10 s, so the log
 *                 shows whether and when the platform killed it (the drain measurement)
 */
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { json } from './http';
import type { RoleContext, RoleHandle, RoleModule } from './types';

export interface ClusterFacts {
  serverVersionNum: number;
  serverEncoding: string;
  localeProvider: string;
  locale: string | null;
}

/** Major, encoding and locale provider of the database a client is connected to. */
export async function clusterFacts(c: pg.Client | pg.PoolClient): Promise<ClusterFacts> {
  const r = await c.query<{ v: string; enc: string; prov: string; loc: string | null }>(
    `select current_setting('server_version_num') as v, current_setting('server_encoding') as enc,
            d.datlocprovider as prov, coalesce(d.datlocale, d.datcollate) as loc
       from pg_database d where d.datname = current_database()`,
  );
  const row = r.rows[0]!;
  const prov = row.prov === 'b' ? 'builtin' : row.prov === 'i' ? 'icu' : row.prov === 'c' ? 'libc' : row.prov;
  return { serverVersionNum: Number(row.v), serverEncoding: row.enc, localeProvider: prov, locale: row.loc };
}

const helloRole: RoleModule = {
  kind: 'service',
  async start(ctx: RoleContext): Promise<RoleHandle> {
    const startedAt = Date.now();
    const instance = randomBytes(4).toString('hex');
    let packListBody: { json: string; gz: Buffer } | null = null;
    let draining: { at: number; reason: string } | null = null;
    const db = { connected: false, lostAt: null as number | null, outages: [] as { ms: number; at: string }[], facts: null as ClusterFacts | null, error: null as string | null };
    let client: pg.Client | null = null;
    let stopped = false;

    const url = ctx.env.DATABASE_URL;
    if (url) {
      const connect = async (): Promise<void> => {
        while (!stopped) {
          try {
            const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
            c.on('error', (e) => {
              db.error = e.message;
            });
            await c.connect();
            db.facts = await clusterFacts(c);
            client = c;
            db.connected = true;
            db.error = null;
            if (db.lostAt !== null) {
              const ms = Date.now() - db.lostAt;
              db.outages.push({ ms, at: new Date().toISOString() });
              ctx.log.info('db-back', { outageMs: ms });
              db.lostAt = null;
            }
            ctx.log.info('db-connected', { ...db.facts });
            return;
          } catch (e) {
            db.error = (e as Error).message;
            await new Promise((r) => setTimeout(r, 250));
          }
        }
      };
      await connect();
      const probe = setInterval(() => {
        if (!client || stopped) return;
        const c = client;
        c.query('select 1').catch((e: Error) => {
          if (client !== c) return;
          client = null;
          db.connected = false;
          db.lostAt = Date.now();
          db.error = e.message;
          ctx.log.warn('db-lost', { error: e.message });
          void c.end().catch(() => undefined);
          void connect();
        });
      }, 1000);
      probe.unref();
    }

    ctx.http.add(async (req, res) => {
      const p = (req.url ?? '/').split('?')[0];
      if (p === '/hello') {
        return json(res, 200, {
          role: ctx.name,
          buildId: ctx.build.buildId,
          instance,
          uptimeS: Math.round((Date.now() - startedAt) / 100) / 10,
          draining: draining ? { sinceS: Math.round((Date.now() - draining.at) / 100) / 10 } : null,
          db: url ? { connected: db.connected, outages: db.outages.length } : null,
        }, { 'Access-Control-Allow-Origin': '*' });
      }
      if (p === '/packs.json' && ctx.services.packList) {
        try {
          const text = JSON.stringify(await ctx.services.packList.get());
          if (packListBody?.json !== text) packListBody = { json: text, gz: gzipSync(text) };
          const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
          const body = gz ? packListBody.gz : Buffer.from(text);
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': String(body.length),
            ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
            Vary: 'Accept-Encoding',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'Cross-Origin-Resource-Policy': 'cross-origin',
          });
          res.end(req.method === 'HEAD' ? undefined : body);
          return true;
        } catch (e) {
          ctx.log.error('pack-list-failed', { error: (e as Error).message });
          return json(res, 503, { error: 'pack list unavailable' }, { 'Access-Control-Allow-Origin': '*' });
        }
      }
      return false;
    });
    ctx.log.info('hello-ready', { role: ctx.name, db: Boolean(url), packList: Boolean(ctx.services.packList) });

    return {
      health: () => ({ ok: true, detail: { standby: true, draining: draining !== null, db: url ? db.connected : null } }),
      async drain(reason, deadlineMs) {
        draining = { at: Date.now(), reason };
        ctx.log.info('drain-start', { reason, deadlineInS: (deadlineMs - Date.now()) / 1000 });
        // Hold past the announced deadline, logging once a second: the log shows when the platform killed us.
        const holdUntil = reason === 'SIGTERM' ? deadlineMs + 10_000 : Date.now();
        while (Date.now() < holdUntil) {
          await new Promise((r) => setTimeout(r, 1000));
          ctx.log.info('drain-heartbeat', { sinceSigtermS: Math.round((Date.now() - draining.at) / 100) / 10 });
        }
        stopped = true;
        const c = client as pg.Client | null;
        if (c) await c.end().catch(() => undefined);
        ctx.log.info('drain-done', { afterS: (Date.now() - draining.at) / 1000 });
      },
    };
  },
};

export default helloRole;
