/**
 * ROLES=standin: the packs bucket stand-in (deploy/local/bucketStandIn.ts) as a role of the image, for the
 * compose form of the local stack ONLY. It serves the bind-mounted packs directory (PACKS_DIR, read-only) as the
 * packs bucket: S3 requests of the shell and presigned URLs signed by game, with the same SigV4 checks as the
 * host stand-in.
 *
 * Why it exists (found on the first compose run, 2026-11-17): on this machine no container reaches a process
 * on the Windows host (host.docker.internal, the gateway and the host's own addresses all time out: the host
 * drops the inbound connections), so the host's stand-in cannot be the containers' bucket. The brief allows
 * the packs bind-mounted (never the plain-file tile tree). It refuses to start unless STACK_LOCAL=1, which only
 * deploy/local/compose.yml sets: production never runs it.
 */
import { startBucketStandIn } from '../local/bucketStandIn';
import type { RoleContext, RoleHandle, RoleModule } from './types';

const standinRole: RoleModule = {
  kind: 'service',
  async start(ctx: RoleContext): Promise<RoleHandle> {
    const env = ctx.env;
    if (env.STACK_LOCAL !== '1') throw new Error('the standin role is the local stack fixture: it runs only with STACK_LOCAL=1 (deploy/local/compose.yml)');
    const need = (k: string): string => {
      const v = env[k];
      if (!v) throw new Error(`standin: ${k} is needed`);
      return v;
    };
    const s = await startBucketStandIn({
      packsDir: env.PACKS_DIR ?? '/packs',
      bucket: need('PACKS_BUCKET'),
      accessKeyId: need('PACKS_ACCESS_KEY_ID'),
      secretAccessKey: need('PACKS_SECRET_ACCESS_KEY'),
      host: '0.0.0.0',
      port: Number(env.STANDIN_PORT ?? 47201),
      log: (l) => ctx.log.info('standin', { line: l }),
    });
    return {
      health: () => ({ ok: true, detail: { port: s.port } }),
      drain: async () => {
        await s.close();
      },
    };
  },
};

export default standinRole;
