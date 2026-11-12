/**
 * The role contract of the program entry (ARCHITECTURE 16.1). One Node program starts the roles that ROLES
 * names, each from the entry the role manifest gives (deploy/roles/manifest.ts), and hands each the shared
 * services: the logger, the egress meter, the build identity, the HTTP router of the process and, where the
 * packs credential is configured, the pack-list service. server/ never imports deploy/: its roles receive
 * these services through this interface, which the entry fills.
 */
import type http from 'node:http';
import type { EgressMeter } from './egress';
import type { Logger } from './log';
import type { PackListService } from '../packs/packList';

/** A request handler of the process's one HTTP server; returns true when it answered. */
export type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => boolean | Promise<boolean>;

export interface RouteOptions {
  /**
   * The paths whose response bytes the handler meters itself (admission against a route of its own, such as
   * the mirror's). Every other response of the process is metered by the program entry against the `public`
   * budget (2 GB a day; then 429).
   */
  metered?: (path: string) => boolean;
}

export interface HttpRouter {
  /** Handlers run in the order roles add them; the first that answers wins. */
  add(handler: RouteHandler, options?: RouteOptions): void;
  /** The port the process listens on (null for a job that serves nothing). */
  port: number | null;
}

export interface BuildIdentity {
  /** Hash of the Node image digest and the server bundle hash (or `host-<bundle hash>` outside the image). */
  buildId: string;
  nodeImageDigest: string | null;
  bundleHash: string | null;
  /** Commit the image was built from, when the build recorded it. */
  commit: string | null;
}

export interface RoleContext {
  name: string;
  env: Record<string, string | undefined>;
  log: Logger;
  egress: EgressMeter;
  build: BuildIdentity;
  http: HttpRouter;
  services: { packList: PackListService | null };
}

export interface RoleHealth {
  ok: boolean;
  detail?: Record<string, unknown>;
}

export interface RoleHandle {
  health(): RoleHealth;
  /**
   * Graceful stop: on SIGTERM (Railway) or the local stack's stop message (Windows cannot deliver SIGTERM to
   * another process). `deadlineMs` is when the platform will kill the process.
   */
  drain(reason: string, deadlineMs: number): Promise<void>;
}

export interface RoleModule {
  /** `service` roles serve until stopped; a `job` role runs once and its result is the process's exit code. */
  kind: 'service' | 'job';
  start(ctx: RoleContext): Promise<RoleHandle & { done?: Promise<number> }>;
}
