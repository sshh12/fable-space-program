/**
 * The role manifest (ARCHITECTURE 16.1): role name -> the module that implements it. The program entry
 * (deploy/main.ts) starts the roles ROLES names from here. One implementation and one owner per role:
 * `shell`, `packs` and `dump` live under deploy/roles (platform-delivery; the dump's schema is
 * server-persistence's). The server roles are the hello stand-in until server-persistence points them at
 * server/ in wave 5 (it edits only the entries below; the launcher, the image and the entry stay as they are).
 */
import type { RoleModule } from './types';

export interface RoleEntry {
  load: () => Promise<{ default: RoleModule }>;
  owner: string;
}

const hello = (): Promise<{ default: RoleModule }> => import('./hello');

export const ROLE_MANIFEST: Record<string, RoleEntry> = {
  shell: { load: () => import('./shell'), owner: 'platform-delivery' },
  packs: { load: () => import('./packs'), owner: 'platform-delivery' },
  dump: { load: () => import('./dump'), owner: 'platform-delivery (schema: server-persistence)' },
  pgsettings: { load: () => import('./pgsettings'), owner: 'platform-delivery (operator job)' },
  derating: { load: () => import('../bench/derating'), owner: 'platform-delivery (measurement job, D7)' },
  game: { load: hello, owner: 'server-persistence (hello stand-in until wave 5)' },
  gate: { load: hello, owner: 'server-persistence (hello stand-in until wave 5)' },
  dir: { load: hello, owner: 'server-persistence (hello stand-in until wave 5)' },
  sim: { load: hello, owner: 'server-persistence (hello stand-in until wave 5)' },
  api: { load: hello, owner: 'server-persistence (hello stand-in until wave 5)' },
  pub: { load: hello, owner: 'server-persistence (hello stand-in until wave 5)' },
};

/** Role names of a ROLES value (`shell`, `game`, `sim-1`: a numbered shard is the `sim` role). */
export function parseRoles(v: string | undefined): { name: string; role: string }[] {
  const names = (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) throw new Error('ROLES is empty: name the roles this process runs (for example ROLES=shell or ROLES=game)');
  return names.map((name) => {
    const role = /^sim-\d+$/.test(name) ? 'sim' : name;
    if (!ROLE_MANIFEST[role]) throw new Error(`ROLES: unknown role "${name}" (known: ${Object.keys(ROLE_MANIFEST).join(', ')})`);
    return { name, role };
  });
}
