# deploy/: the program, its roles, the image, the local stack and stage 0 on Railway

Owner: `platform-delivery` (ARCHITECTURE 10.4, 13.1, 16). Hand-off: `docs/handoff/platform-delivery.md`.

## The program and its roles

One Node program (`deploy/main.ts`, bundled to one ES module by `deploy/build/build-server.mjs`), one image
(`deploy/Dockerfile`), roles chosen by `ROLES` (comma-separated) from the role manifest
(`deploy/roles/manifest.ts`):

| Role | Module | What it is |
|---|---|---|
| `shell` | `roles/shell.ts` | static front end: the client build, `/endpoints.json`, `/boot/<hash>.pack` (loaded from the packs bucket at start, verified; health waits for it), the packs mirror, egress budgets, `/version.json`, `/_whoami` |
| `packs` | `roles/packs.ts` | the mirror alone (stage 3; the `launch` shape) |
| `dump` | `roles/dump.ts` | cron job: `pg_dump -Fc` to the dumps bucket, skip rule, budget, retention |
| `pgsettings` | `roles/pgsettings.ts` | operator job: production's `ALTER SYSTEM` values, cluster facts |
| `game`, `gate`, `dir`, `sim-<n>`, `api`, `pub` | `roles/hello.ts` | the hello stand-in until `server-persistence` points them at `server/` (wave 5) |

Shared services handed to every role: the logger (`roles/log.ts`, JSON lines), the egress meter
(`roles/egress.ts`, one per process), the build identity (`buildInfo.ts`), the process's HTTP router on `PORT`,
and the pack-list service (`packs/packList.ts`) where the packs credential is configured. `/healthz` is 200
only when every role of the process is healthy.

## Variables, per service

| Variable | Who | Meaning |
|---|---|---|
| `ROLES` | every process | the roles to run |
| `PORT`, `HOST` | services | listen address (default 8080, 0.0.0.0) |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | game (45), postgres (60) | the drain window after SIGTERM |
| `DATABASE_URL` | game, dump, pgsettings | `${{postgres.DATABASE_URL}}` (never leaves Railway) |
| `PACKS_BUCKET`, `PACKS_ENDPOINT`, `PACKS_REGION`, `PACKS_ACCESS_KEY_ID`, `PACKS_SECRET_ACCESS_KEY`, `PACKS_PATH_STYLE` | game, shell (and the upload tool on this machine) | the packs bucket |
| `DUMPS_BUCKET`, `DUMPS_ENDPOINT`, `DUMPS_REGION`, `DUMPS_ACCESS_KEY_ID`, `DUMPS_SECRET_ACCESS_KEY`, `DUMPS_PATH_STYLE` | dump ONLY (and the Modal secret `fsp-dumps`) | the dumps bucket; the dump role refuses to start if it also holds the packs credential |
| `MIRROR_BASE`, `MIRROR_MODE`, `MIRROR_SLICE_BYTES` | game (the pack list), shell (`MIRROR_SLICE_BYTES`) | the mirror the pack list announces; mode `slices`, 262144 bytes (measured, D5) |
| `PACK_SETS_FILE` / `PACK_SETS_DIR` | game | the sets the pack list offers: `deploy/pack-sets.json` in the image (what was uploaded) / a local `data/packs` |
| `PACK_MIRROR_ORDER` | game | default `bucket,mirror` |
| `STATIC_DIR`, `CLIENT_BUILD`, `BOOT_MANIFEST` | shell | the client build (image: `/app/client`), its hash, `deploy/boot-manifest.json` |
| `ENDPOINT_GATE`, `ENDPOINT_API`, `ENDPOINT_PUB` | shell | the endpoint document's ordered candidates (comma-separated) |
| `EGRESS_CLIENT_BYTES_PER_DAY` (3e9), `EGRESS_BOOT_BYTES_PER_DAY` (1e9), `EGRESS_MIRROR_BYTES_PER_DAY` (8e9), `MIRROR_PER_ADDRESS_BYTES` (300e6), `MIRROR_PER_ADDRESS_WINDOW_S` (600) | shell | the egress budgets |
| `DUMP_BUDGET_BYTES_PER_DAY` (1.5e9), `PG_DUMP` | dump | upload budget; the pg_dump binary (image: the PGDG 18 client) |
| `STACK_CONTROL_TOKEN` | local stack only | `POST /_ctl/stop` (Windows cannot deliver SIGTERM); never set in production |

## Commands

```
node deploy/build/build-server.mjs --out=<dir>        # the server bundle (deterministic)
node <dir>/main.mjs                                    # with ROLES=... and the variables above

# packs (tools/pack/cli.ts; data/packs is git-ignored, at most 20 GB, kept until a copy outside the bucket exists)
node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/pack/cli.ts tiles [--sets=earth,moon]
node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/pack/cli.ts files            # sky, assets
node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/pack/cli.ts boot --build=data/stack/client/<hash>
npx tsx tools/pack/cli.ts upload --sets=moon,sky,assets,earth [--boot=<hash>]       # resumable; writes deploy/pack-sets.json, deploy/boot-manifest.json
npx tsx tools/pack/cli.ts verify | cors | status

# the local stack (ARCHITECTURE 16.4): see deploy/local/launcher.ts for every option
STACK_NAME=fsp-<package> npm run stack -- [--shape=combined|split|launch] [--page=dev|build] [--fresh] -- <command>
npm run stack -- status | down

# stage 0 on Railway (deploy/railway/provision.mjs is the runbook; idempotent)
railway bucket credentials --bucket packs --json | node deploy/railway/env-from-bucket.mjs PACKS
node deploy/railway/provision.mjs services            # services, settings, limits, volume, variables, domains
node deploy/railway/provision.mjs deploy <service>    # clean export of HEAD, built by Railway from deploy/Dockerfile
node deploy/railway/provision.mjs ops pgsettings      # ALTER SYSTEM in the private network; then: railway restart --service postgres
node deploy/railway/usage.mjs snapshot | report       # the cost reading (ARCHITECTURE 29.2)

# Modal (environment fsp)
npx tsx deploy/modal/make-requests.ts && modal run --env fsp deploy/modal/fsp_probe.py
```

`deploy/local/compose.yml` (the pinned image, Postgres 18, MinIO) is reached only through the launcher
(`--compose`), which refuses unless `%UserProfile%\.wslconfig` caps the WSL 2 VM at 6 GB or less.
