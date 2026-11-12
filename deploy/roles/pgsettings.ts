/**
 * `pgsettings`: an operator job (ARCHITECTURE 16.2, stage 0 in detail): applies production's Postgres
 * settings through ALTER SYSTEM (shared_buffers=96MB, max_wal_size=256MB, min_wal_size=64MB,
 * max_connections=40), and reports the cluster's major, encoding and locale provider and every setting with
 * whether it is pending a restart. Idempotent: a setting already in force is left alone.
 *
 * Run once inside the private network with the database URL, which never leaves Railway: the `dump` cron
 * service's ROLES set to `pgsettings` for one deployment (deploy/railway/provision.mjs pgsettings), then the
 * Postgres service restarted, then once more to confirm (`pending_restart` false everywhere).
 * Exit 0 when the cluster is UTF8 with the built-in locale provider; 5 otherwise.
 */
import pg from 'pg';
import { clusterFacts } from './hello';
import type { RoleContext, RoleHandle, RoleModule } from './types';

export const PRODUCTION_PG_SETTINGS: [string, string][] = [
  ['shared_buffers', '96MB'],
  ['max_wal_size', '256MB'],
  ['min_wal_size', '64MB'],
  ['max_connections', '40'],
];

const pgSettingsRole: RoleModule = {
  kind: 'job',
  async start(ctx: RoleContext): Promise<RoleHandle & { done: Promise<number> }> {
    const url = ctx.env.DATABASE_URL;
    if (!url) throw new Error('pgsettings: DATABASE_URL is needed');
    const done = (async (): Promise<number> => {
      const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
      await c.connect();
      try {
        const facts = await clusterFacts(c);
        ctx.log.info('pg-cluster', { ...facts });
        const applied: string[] = [];
        const errors: Record<string, string> = {};
        for (const [k, v] of PRODUCTION_PG_SETTINGS) {
          const cur = (await c.query<{ v: string }>('select current_setting($1) as v', [k])).rows[0]!.v;
          if (cur === v) continue;
          try {
            await c.query(`ALTER SYSTEM SET ${k} = '${v}'`);
            applied.push(`${k}=${v} (was ${cur})`);
          } catch (e) {
            errors[k] = (e as Error).message;
          }
        }
        await c.query('select pg_reload_conf()');
        const rows = (await c.query<{ name: string; setting: string; unit: string | null; pending_restart: boolean }>(`select name, setting, unit, pending_restart from pg_settings where name = any($1)`, [PRODUCTION_PG_SETTINGS.map(([k]) => k)])).rows;
        ctx.log.info('pg-settings', { applied, errors, now: rows });
        return facts.serverEncoding === 'UTF8' && facts.localeProvider === 'builtin' ? 0 : 5;
      } finally {
        await c.end();
      }
    })();
    return { done, health: () => ({ ok: true }), drain: async () => undefined };
  },
};

export default pgSettingsRole;
