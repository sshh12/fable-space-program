# platform-delivery: hand-off

Wave 3.1 of `docs/WORK_PACKAGES_V2.json`: tile packs and their delivery, the tile-source seam, the boot pack,
the program entry and the static roles, CI and the image, the local stack, the stage-0 skeleton on Railway's
Hobby plan and the first cloud measurements.

Measured numbers of the cloud part are in `docs/capacity/2026-11-12-platform.md`; the running log of the
session is at the end of this file.

## 0. In five lines

**First line, as the brief asks, corrected in the fix round: the packs bucket at 2,000 concurrent fetchers is
INCONCLUSIVE, not a fail** (the fleet's containers started 9.6 minutes apart, the Gbit/s was one container's
900 s, the requests were 26 kB groups instead of about 85 kB coalesced ranges, Moon packs only, region
unpinned); it passes at 20 and 500. The pass line is 2.1-2.7 Gbit/s (the front-page day), not 1.5. Nothing is
escalated: that needs the bucket AND the mirror to fail, and the mirror at launch size is unmeasured. Rerun
recipe: `docs/capacity/2026-11-12-platform.md` section 6.

**Fix round (2026-11-12 evening): section 0a lists every review item with its evidence.** The production shell
no longer serves source maps (it did, with the private sources, until 18:35 UTC).

- **Local: done and proven.** Packs of every baked tile set (17.12 GB in 29 sets since the fix round; first round 13.96 GB in 96 packs), the pack source with the
  tile-source seam, byte-identical to the plain files for all 862,220 tiles in four modes; the boot pack (22.4 MB
  boot set); the program entry and the static roles; the local stack on host processes with an embedded
  Postgres 18 (UTF8, built-in C.UTF-8) in three shapes, with its slot, lock, status and down all tested.
- **CI: green on a branch** (`platform-delivery-ci`) in about 2.5 minutes of wall time, and it fails on a planted
  secret, a planted TODO and a planted boundary violation (three throwaway branches, deleted).
- **Cloud: the stage-0 skeleton is up on the Hobby plan** (game, shell with CDN, postgres 18, hourly dump, two
  buckets; Modal environment `fsp`), and costs U + $5 = $7.51 against the $30 idle ceiling over a 4.5-hour
  nearly idle window (the hello roles: a floor, not the real game); the whole package spent $0.033 on Railway.
- **Not done**: the 6-hour and 72-hour idle cost readings (time), the compose suites (Docker not allowed
  this round), two browser tests on the local stack (local failover, terrain hash in the page: both proven in
  Node; the GPU queue was 90 minutes deep). Section 7.
- **Findings that change figures of ARCHITECTURE**: the boot pack cannot hold levels 0-3 (122 MB); Railway's CDN
  never caches a ranged response, so the mirror serves 256 KiB slices; a first session is 461-577 MB, not 300.

## 0a. Fix round: what was fixed, with the evidence

| # | Item | State | Evidence |
|---|---|---|---|
| 1 | Source maps were public on the production shell | **Fixed, proven** | Commit a4d824c (the CI and image build has `sourcemap: false`; the image deletes any `*.map` and fails on a `sourceMappingURL`; shell answers 404 to `*.map` unless the local stack sets SHELL_SOURCE_MAPS=1). Deployed shell 68b4093: GET `/assets/main-uVdGZXLE.js.map` 404, the worker's map 404, 0 `sourceMappingURL` in the served JS; the old map URL 404 and `DYNAMIC` at the edge (it had been served `no-cache`, so no CDN edge kept it) |
| 2 | Egress budgets not a hard stop | **Fixed, proven in unit tests and on the deployed mirror** | `EgressMeter.admit` reserves a response's length against the day and the address window before the first byte and takes a stream slot (mirror 128 / 32 per address, boot 16 / 2); `settle` gives back an aborted stream's rest. Slices mode: an unsliced GET is 404; ranges mode: open-ended, suffix, multiple, missing or > 8 MiB ranges are 416. Tests: 100 admissions at once against 1,000 bytes admit exactly 3; 64 slice requests at once against a 10-slice budget serve exactly 10 (bytes sent = 10 x 64 KiB <= budget, meter settles to it); stream caps; address window. Deployed: `/p/<h>` 404, `/p/<h>` with a Range 404, `/p/<h>/0` (old form) 404, a 100000-byte S 404, a query string 404 |
| 3 | game served unmetered public bytes | **Fixed, proven** | Every response no role meters itself is admitted against `public` (2 GB a day, 429 past it; Railway's health check of /healthz still answered; unit test). Deployed /hello: `{role, buildId, instance, uptimeS, draining, db:{connected, outages}}`, no deployment or replica id, no pid, no error text; /healthz carries no role detail; /packs.json 6,934 bytes gzip against 48,220 plain |
| 4 | OPFS cache | **Fixed; proven in unit tests; the browser test is written, not run** | Size checked against the key's length at adoption and on get (a truncated or 0-byte entry is a miss and removed); every error a miss or a no-op (quota on write, a throwing cache, a cache that never opened: `stats.cacheErrors`); one owner per directory via the Web Lock `fsp-opfs-cache:<dir>`, other contexts read-only. Unit tests on an in-memory OPFS and lock manager (truncated, quota, broken cache, two contexts). Browser test (page + worker on real OPFS, a truncated file) in `packs.spec.ts`: see item 13 |
| 5 | Pack source edge cases | **Fixed, proven in unit tests** | A 403 that persists after the refresh is penalised (the next read goes to the mirror first); a refreshed list naming another index for a set drops the set and reads the new index (test with a real re-pack); time allowance = timeoutMs + bytes at minBytesPerSecond (256 KiB/s); tests for the network-error refresh on presigned URLs and the 24-in-flight cap (peak 20-24 of 200 single-tile requests) |
| 6 | Slice size in the URL | **Fixed, deployed, proven** | `/p/<hash>/<S>/<n>`, S a power of two from 64 KiB to 4 MiB; the pack list's sliceBytes is the only source (shell no longer reads MIRROR_SLICE_BYTES). Both services redeployed (shell and game at buildId 91cee8cf59e94c17); `/p/<h>/262144/0` 200 with 262,144 bytes |
| 7 | Packer reuse and the release check | **Fixed, proven, and used** | `tools/pack/cli.ts check` reads every promised tile and file through the pack source in whole-pack mode against the source and writes `verified.json` only when clean; `upload` refuses a set without it or packed from another contentHash than its manifest's now; `verify` reports released sets whose contentHash is not the tree's (it reported earth ab20fdfc579d4015 against f5e6ef420bda7cea before the re-pack). The follow-up (re-pack Earth and pack 25 bodies, upload, redeploy) is section 0b |
| 8 | Seal the secrets; rotate the dumps key; Modal secret without a file | **Done** | PACKS_SECRET_ACCESS_KEY (game, shell), DUMPS_SECRET_ACCESS_KEY (dump), POSTGRES_PASSWORD (postgres) sealed (`provision.mjs seal-state`). POSTGRES_PASSWORD was sealed only after a deployment proved a cross-service reference to a sealed variable resolves (an ops job reached the database through a sealed probe variable of postgres; probe and ops service deleted). Dumps key rotated (`rotate-dumps.mjs`): the dump service's key id is the bucket's current one, the new pair lists the bucket (38 dumps), the Modal secret was written through the SDK on stdin (no file, no argv; no `fsp-secret-*` file in the temp directory) and `copy_dump` ran with it after the app was redeployed (a deployed Modal app holds the secret object it was deployed with: the script now redeploys it). No value was printed |
| 9 | Capacity report corrections | **Done** | D6 INCONCLUSIVE with the five reasons, the recomputed pass line (2.1-2.7 Gbit/s) and a rerun recipe; the escalation needs bucket AND mirror; D8's 1.38 on tiles only (533 MB, about $1,330 for the all-miss day, from a local replay); the reviewer's 6.43 h reading (U $2.58, U+5 $7.58) as the floor |
| 10 | CI and image | **Done; the image job proven on CI** | Actions pinned by SHA; CI on pushes to main, PRs into main and by hand; the PGDG key checked by fingerprint B97B0AFC...ACCC4CF8 and postgresql-client-18 / libpq5 pinned to 18.7-1.pgdg12+2; buildId equality stated (Node base and server bundle, not the client: compared by clientBuild). Run 43289997443 (by hand on `platform-delivery-ci` at 2baffe6): image job green in 146 s with the pinned client; the checks job failed on two other packages' unit files (`tests/unit/planet-bake/landmarks.test.ts`, `tests/unit/sim-vessel/codec.test.ts` corpus), not touched here |
| 11 | Launcher and self-test | **Fixed, proven** | The use-file regex `/\.use-(\d+)$/`; the refusal checks encoding, provider AND locale C.UTF-8 (unit test: a built-in C cluster is refused); database steps retry a reset connection (kill-row); `offline` samples every TCP connection of the stack's processes. Self-test: kill, kill-row, names-state, refuse, offline all PASS (offline: no Docker process, no connection off the loopback in 5 samples of 5 processes and their children) |
| 12 | Bucket CORS | **Fixed, proven** | Origins: the shell's, `http://127.0.0.1:47200`, `http://localhost:47200` (Tigris takes no wildcard in an origin: `http://127.0.0.1:*` was not honoured). GET with Origin: the three get their own origin back; `https://evil.example` and another local port get none (preflight 403) |
| 13 | Browser tests | see section 0b | |

## 0b. The release after the final bakes (the coordinator's follow-up to item 7)

- **Packed** (bake slot): Earth re-packed incrementally at manifest contentHash f5e6ef420bda7cea (Madrakah
  re-baked): 72 packs, 60 unchanged, 12 rewritten, index a98a3b8296b684fa1e21397ecf6ff6ae, 750,486 tiles,
  10.72 GB; the 25 small bodies packed (ariel, callisto, ceres, charon, deimos, dione, enceladus, europa,
  ganymede, iapetus, io, mars, mercury, mimas, miranda, oberon, phobos, pluto, rhea, tethys, titan, titania,
  triton, umbriel, venus): 85 packs, 147,612 tiles, 2.74 GB (mars 0.89, mercury 0.64, pluto 0.32, venus 0.17,
  ceres 0.16 GB; the rest 2-66 MB each).
- **Verified**: `tools/pack/cli.ts check` on all 29 packed sets in whole-pack mode against the plain files:
  1,062,972 tiles and every plain file, 17.12 GB, **0 mismatches on the 27 tile sets and sky**; the `assets` file
  set is stale against today's public/assets (66 differences: files added and changed since it was packed by
  other packages) and was not released again (its released copy is the one the client used before). The sweep
  inside the stack (`pack-sweep.ts sweep --min-sets=27 --modes=whole,slices`): 27 tile sets, whole packs and the
  mirror's 256 KiB slices, **0 mismatches**.
- **Released**: the release check passed for each of the 26 sets; 121 new objects (3.81 GB) uploaded at about
  30 Mbit/s, nothing overwritten, old objects kept. `verify`: 216 released objects present, no released tile set
  stale. The packs bucket now holds 222 objects, **17.79 GB** (released sets 17.12 GB; the rest is the boot pack
  and the objects of the earlier Earth release). Local data/packs 17.12 GB after pruning the earlier Earth
  objects (free 33.5 GB).
- **Deployed and proven from outside** (game and shell at commit f025da8, buildId 6df6b1d94ecf397d): the pack
  list offers 29 sets; through the bucket's presigned ranges and, separately, through the mirror's 256 KiB
  slices, the Earth manifest read from the deployed index has contentHash **f5e6ef420bda7cea, equal to the
  tree's**; the Madrakah level-12 height tile 2/12/758/2888 (re-baked today), Mars height 5/5/31/31 and Pluto
  albedo 0/2/0/0 read back **byte-identical** to data/tiles (12 bucket requests, 10 mirror requests, no
  failure).
- **Modal volume fsp-packs**: see the running log (copy_packs from the deployed pack list).

## 1. What exists locally

| Item | Where | State |
|---|---|---|
| Pack format (`TilePackIndex` and the boot pack format, the pack list type) | `src/terrain/packIndex.ts` | done; the lead lifts `TilePackIndex` into `terrain.ts` |
| The packer: content-defined, incremental, deterministic | `tools/pack/packer.ts`, CLI `tools/pack/cli.ts` | done |
| Packs | `data/packs/` (git-ignored): earth 66 packs 10.30 GB (index 4.55 MB), moon 27 packs 3.39 GB (index 1.66 MB), sky 1 pack 135 MB, assets 2 packs 136 MB; **13.96 GB in all**, plus the boot pack 20 MB | built 2026-11-12 from earth contentHash of that day and moon `597c5d666b132450`; **keep until the Modal copy exists and the lead says so** |
| The pack source | `src/terrain/packSource.ts` | done: ranges and slices, coalescing, bounded requests, failover, OPFS cache, boot pack |
| OPFS cache | `src/terrain/opfsCache.ts` | done |
| `createTileSource(spec)` | `src/terrain/tileSource.ts` (fetch, pack), `src/terrain/tileSource.node.ts` (adds fs) | done |
| Boot pack and manifest | `tools/pack/boot.ts`, `deploy/boot-pack.json` (what goes in, by priority), `deploy/boot-manifest.json` (tracked: hash, bytes, included, deferred) | done; uploaded |
| Program entry, role manifest, roles | `deploy/main.ts`, `deploy/roles/*` | done (server roles are the hello stand-in) |
| Server bundle, build identity, image | `deploy/build/*`, `deploy/buildInfo.ts`, `deploy/Dockerfile` (+ `Dockerfile.dockerignore`) | done; built by CI and by Railway |
| Local stack | `deploy/local/stack.mjs` -> `launcher.ts`, `bucketStandIn.ts`, `compose.ts`, `compose.yml` | host form done and tested; compose form built, not run |
| CI | `.github/workflows/ci.yml`, `deploy/ci/secret-patterns.mjs` | green |
| Railway and Modal tooling | `deploy/railway/*` (provision, usage, env and list tools), `deploy/modal/*` (probe, offsite copy, secret) | done |
| Tests | `tests/unit/platform/*` (unit, in-stack, self-test, sweep), `src/terrain/tileSource.test.ts`, `tests/browser/platform/*`, `labs/platform/` | see section 5 |

## 2. What exists in the cloud (every resource, its id, how to delete it)

Railway project **fable-space-program** (`7cc16fa5-1790-44e6-8087-4e75673a5a7a`), environment **production**
(`11958a85-d81f-4639-9d77-90bbef65e27b`), Hobby plan, region us-east4-eqdc4a. Nothing else in the workspace was
touched; `haulpoint-tms` is as it was. No usage limit was set (a hard limit is per workspace and would stop
`haulpoint-tms`; a soft limit is an e-mail alert, which the user does not want); the budget guards are the
replica limits below and the egress budgets in the roles.

| Resource | Id | Settings | Delete |
|---|---|---|---|
| service `game` | c3c9e85c-d3c2-4f72-bf90-86c59ab0929d | hello role, `ROLES=game`; limit 2 vCPU / 2 GB; health `/healthz`; draining 45 s; restart Always; no repo source (autodeploy off); domain game-production-dfc41bff.up.railway.app; holds the packs credential | `railway service delete --service game --environment production --yes` (or the dashboard) |
| service `shell` | f86d5d8f-67a3-4828-9bca-5ac4707043be | `ROLES=shell`; limit 0.5 vCPU / 0.25 GB; CDN on; health `/healthz` (waits for the boot pack); domain shell-production-b6007648.up.railway.app; holds the packs credential | as above, `--service shell` |
| service `postgres` | 77bea2f1-a875-4eee-8889-c7e43368a7ca | image ghcr.io/railwayapp-templates/postgres-ssl:18; POSTGRES_INITDB_ARGS set before the first boot; ALTER SYSTEM values in force; limit 1 vCPU / 0.5 GB; private network only; password generated inside Railway | `--service postgres` (then its volume) |
| volume of postgres | (listed by `railway volume list`) | 5 GB at /var/lib/postgresql/data | `railway volume delete` |
| service `dump` | c93a9302-50e5-41b6-b21c-631a3bba04f9 | `ROLES=dump`, cron `7 * * * *`, restart Never, limit 1 vCPU / 0.5 GB; holds ONLY the dumps credential | `--service dump` |
| bucket `packs` | 3ca8455f-988e-4425-a9f0-f024512cecfd | US East (iad); S3 name and endpoint in `deploy/railway/buckets.json`; CORS set; holds `p/<hash>` objects (packs, indexes, the boot pack) | `railway bucket delete --bucket packs --yes` (never while anything serves from it) |
| bucket `dumps` | 56ba9069-0144-4099-b8bf-a6497a9e98f3 | US East; `dumps/<utc>-<marker>.dump` | `railway bucket delete --bucket dumps --yes` |
| bucket `packs-orphan-undeployed` | 4dad6994-31d6-47e2-865c-1521299558d6 | empty, in no environment (a race between the two `bucket create` calls) | the dashboard (the CLI cannot reach a bucket that is in no environment) |
| service `ops` (temporary) | c1aebc95-55ee-4da2-95c0-90837faa0a2a | ran `pgsettings` twice | deleted |

Modal, environment **fsp** (created by this package; the four apps of `main` untouched):

| Resource | Kind | Delete |
|---|---|---|
| `fsp-offsite` | deployed app: `copy_dump` nightly at 04:17 UTC, `copy_packs` on demand | `modal app stop --env fsp fsp-offsite` |
| `fsp-probe` | ephemeral app (`modal run`), gone when a run ends | - |
| `fsp-dumps` | secret: the dumps bucket credential (the only copy outside Railway) | `modal secret delete --env fsp fsp-dumps` |
| `fsp-dumps` | volume: the newest dumps (one so far: 20261112T100751Z-none.dump) | `modal volume delete --env fsp fsp-dumps` |
| `fsp-packs` | volume: the copy of the packs (filled by `copy_packs`) | `modal volume delete --env fsp fsp-packs` |
| `fsp` | the environment | `modal environment delete fsp` |

GitHub: branch `platform-delivery-ci` (CI proof; main untouched); delete with
`git push origin --delete platform-delivery-ci`. Credentials: the packs key pair is in this machine's
git-ignored `.env` (`PACKS_ACCESS_KEY_ID`, `PACKS_SECRET_ACCESS_KEY`; the rest of the bucket settings is not
secret and is tracked in `deploy/railway/buckets.json`); the dumps credential exists only in Railway (`dump`)
and the Modal secret; the database password only in Railway.

Fix round changes in the cloud: PACKS_SECRET_ACCESS_KEY (game, shell), DUMPS_SECRET_ACCESS_KEY (dump) and
POSTGRES_PASSWORD (postgres) are **sealed** (irreversible; `node deploy/railway/provision.mjs seal-state`); the
dumps key pair was **rotated** (`node deploy/railway/rotate-dumps.mjs`; the old pair is revoked) and the Modal
secret `fsp-dumps` rewritten and `fsp-offsite` redeployed with it; the packs bucket's **CORS** names three
origins (the shell's, `http://127.0.0.1:47200`, `http://localhost:47200`); a second temporary `ops` service
(31b946ae-edc5-41b1-b9a9-ef55b49f7e93, the sealed-reference probe) was created and deleted; the packs bucket
holds 222 objects, 17.79 GB (section 0b). Nothing else was created.

## 3. Public API (exact signatures)

`src/terrain/tileSource.ts` (browser main thread, workers, Node):

```ts
export function createTileSource(spec: TileSourceSpec): TileSource            // 'fetch' | 'pack'; 'fs' throws, naming tileSource.node.ts
export function createFetchTileSource(baseUrl: string): TileSource           // unchanged
export function validateTileManifest(m: unknown, tileset: string): TileManifest  // unchanged
```

`src/terrain/tileSource.node.ts` (Node only): `export function createTileSource(spec: TileSourceSpec): TileSource`
(all three kinds; `fs` is `createFsTileSource`, unchanged).

`src/terrain/packSource.ts`:

```ts
export function createPackTileSource(o: PackSourceOptions): PackTileSource
export interface PackSourceOptions {
  packListUrl: string;
  cache?: ByteCache | Promise<ByteCache> | null;   // e.g. openOpfsCache({ maxBytes })
  fetch?: typeof fetch;                            // injected (tests, whole-pack mode)
  timeoutMs?: number;                              // 15 000: a mirror that does not answer is failed over
  coalesceGapBytes?: number;                       // 64 KiB
  maxRangeBytes?: number;                          // 8 MiB
  sliceCacheBytes?: number;                        // 64 MiB of slices in memory (slice mode)
  batchTurns?: number;                             // 3 microtask turns to collect a batch
  maxConcurrent?: number;                          // 24 requests in flight
  now?: () => number;                              // a clock, injected: refresh the list after refreshAfterS
}
export interface PackTileSource extends TileSource {
  fileRange(set: string, relPath: string, from: number, length: number): Promise<Uint8Array>;
  addBootPack(bytes: Uint8Array): void;            // FPB1 bytes, verified by the caller
  packList(): Promise<PackList>;
  sets(): Promise<string[]>;
  stats(): PackSourceStats;                        // requests, bytes and failures per mirror, bytesNeeded, fromBoot/Cache/Network
}
export const PENALTY_READS = 64;
```

`src/terrain/opfsCache.ts`: `openOpfsCache(o: { maxBytes: number; dirName?: string }): Promise<ByteCache>`;
`interface ByteCache { get(key); put(key, bytes); usage(); flush() }`; keys `<hash>.<offset>.<length>`;
`OPFS_CACHE_DIR = 'fsp-packs'`.

`src/terrain/packIndex.ts` (shared by packer and client; the lead lifts `TilePackIndex`): `TilePackIndex`,
`PackRef`, `PackKind`, `PackSection`, `PackFileEntry`, `GroupRecord`, `PackList`, `PackListMirror`, `BootEntry`,
`BootPackHeader`; constants `PACK_MIN_BYTES` (64 MiB), `PACK_MAX_BYTES` (256 MiB), `SECTION_MAX_RECORDS` (4096),
`ABSENT_LENGTH`, `HASH_HEX` (32), `MAX_PACK_LEVEL` (15); functions `mortonEncode/Decode`, `tileKinds`,
`kindMaxLevel`, `groupSet`, `groupSetSize`, `groupCodeAt`, `groupOrdinal`, `findSection`, `recordBytes`,
`encodeRecord`, `decodeRecord`, `layerRange`, `groupBytes`, `encodeIndexObject`, `indexHeaderLength`,
`decodeIndexHeader`, `encodeBootPack`, `decodeBootPack`, `bootTileKey`, `validatePackList`, `isContentHash`.

The pack format in one paragraph: a set (tile set or file set) is packs `<hash>.pack` (content-addressed,
64-256 MiB, content-defined boundaries) and one index object `<hash>.idx` (FPI1: header JSON with packs, kinds,
sections and plain files; binary sections of records `u16 pack, u32 offset, u32 length per layer`). A tile
group is every layer of one kind at one coordinate, adjacent; kinds are `height` and `surface` for a large body,
one per layer for a small one, and `files`. Groups go by level, face, Morton order; a group's ordinal is computed
from the manifest (no key in the file). The pack list (`PackList`): ordered mirrors (`objects` per-hash URLs
or `base` + hash [+ `/n`]; mode `ranges` or `slices` with `sliceBytes`) and per set the index hash and size.

Server side (`deploy/`): the role contract (`deploy/roles/types.ts`: `RoleModule { kind; start(ctx) }`,
`RoleContext { name, env, log, egress, build, http, services: { packList } }`, `RoleHandle { health(), drain() }`),
the role manifest (`ROLE_MANIFEST`, `parseRoles`), `EgressMeter` (`open`, `record`, `refuse`, `request`,
`addressOpen`, `secondsToReset`, `snapshot`), `createPackListService`, `createMirrorHandler`, the bucket helpers
(`bucketFromEnv`, `presignGet`, `putIfAbsent`, ...). Variables per service: `deploy/README.md`.

The endpoint document (`GET /endpoints.json` of `shell`, no-cache): `{ v: 1, build, gate: string[], api: string[],
pub: string[], bootPack: { url, hash, bytes } }`. The pack list: `GET /packs.json` of the process that carries
`api` (the hello game today), CORS `*`.

## 4. How to run and verify

```
npx vitest run tests/unit/platform src/terrain/tileSource.test.ts             # 36 tests; the 9 in-stack tests skip outside a stack
npx tsx tests/unit/platform/stack-selftest.ts                                 # the slot, kill, names, refusal, shapes, status (starts stacks itself)
STACK_NAME=fsp-platform-delivery npm run stack -- -- npx vitest run tests/unit/platform/localStack.stack.test.ts
EGRESS_MIRROR_BYTES_PER_DAY=1e13 MIRROR_PER_ADDRESS_BYTES=1e13 STACK_NAME=fsp-platform-delivery npm run stack -- -- node tools/dev/heavy.mjs --class=cpu -- npx tsx tests/unit/platform/pack-sweep.ts sweep
node tools/dev/heavy.mjs --class=cpu -- npx tsx tests/unit/platform/pack-sweep.ts trace-local docs/capacity/traces/first-session-2026-11-12.json
STACK_NAME=fsp-platform-delivery npm run stack -- -- node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/platform/packs.spec.ts --project=functional
STACK_NAME=fsp-platform-delivery npm run stack -- --page=build -- node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/platform/coldstart.spec.ts --project=functional
DEPLOYED_GAME=https://game-production-dfc41bff.up.railway.app DEPLOYED_EXPIRED_LIST=out/platform/expired-list.json node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/platform/deployed.spec.ts --project=functional
RECORD_SESSION=1 node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/platform/session-trace.spec.ts --project=functional
```

The sweep lifts the stack shell's mirror budgets through the environment (8 GB a day and 300 MB per address
in 10 minutes would refuse a 14 GB sweep: that is the budget working). Compose (when `.wslconfig` caps the VM
at 6 GB): `STACK_NAME=fsp-platform-delivery npm run stack -- --compose -- <suite>`; `docker compose run --rm dump`
inside it dumps the compose Postgres to MinIO.

## 5. Acceptance, criterion by criterion

Updated in the fix round, as the review laid it out: **Proven** (a run whose output is recorded here or in the
capacity report), **Claimed** (built and reasoned, or proven in a weaker form than the criterion asks), **Not
done**.

| Criterion | State | Evidence |
|---|---|---|
| Every tile through `createTileSource({kind:'pack'})` byte-identical to fs, whole-pack mode and the mirror modes | **Proven** | Full sweeps inside the stack: earth and moon in four modes (first round, 0 mismatches); after the final bakes, 27 tile sets in whole-pack mode and 256 KiB slices (0 mismatches, `--min-sets=27`), plus `check` on all 29 sets (0 mismatches on the tile sets and sky). From outside on the deployed services: Earth's manifest contentHash and three tiles byte-identical through the bucket and through the mirror (section 0b) |
| Request count of a recorded flight trace at least 5x lower than per-file | **Proven with the client cache; not met without it** | 2,508 requests against 26,023 (10.4x) with the OPFS-like cache; 4.2x with no cache at the 64 KiB gap. A local replay of one 4-minute session |
| Browser: main thread and worker (CORS, COEP, no Content-Range), OPFS on reload, failover, terrain hash in the page | **Proven**: main + worker, OPFS on reload, failover against the deployed services. **Proven in Node, browser form: see section 0b / running log**: local-stack failover and the terrain hash in the page. OPFS ownership and truncation (fix 4): proven in unit tests, browser form in the same run |
| Boot set at most 25 MB, cold under 8 s at 50 Mbit/s, shell refuses a wrong pack | **Proven** | 22.4 MB; 22.56 MB in 4.05 s (local stack, `--page=build`); health fails on a missing pack and a wrong size (unit test); the deployed shell verified 5b7c3d4f... |
| Egress budgets stop each route; query string 404; per-address limit; reset at 00:00 UTC | **Proven (hard stop since the fix round)** | Reservation at admission and stream caps (unit tests: concurrent admissions never pass the budget; 64 concurrent slices against a 10-slice budget serve 10); every other public response against a 2 GB `public` budget; on the deployed shell: query strings, unsliced GETs, wrong slice sizes 404 |
| CI green under 8 minutes, builds client and image, fails on a planted secret, TODO and boundary | **Proven in the first round; image proven again after the pins** | Runs 43195587786 / 43196339349 green, planted runs failed at the right step. After the fix round (actions pinned, PGDG pinned): run 43289997443, image green in 146 s; checks red on two other packages' unit files (planet-bake landmarks, sim-vessel codec corpus) |
| Local stack starts with Docker stopped and no network | **Proven** | Self-test `offline`: no Docker process; no TCP connection off the loopback in 5 samples of all stack processes and children |
| Postgres ready under 1 s | **Proven** | initdb 1.0 s, then 152-280 ms |
| Advisory lock, fenced write, a committed row survives a hard kill | **Proven** | In-stack suite; self-test `kill-row` (now with retries on a reset connection) |
| UTF8 with built-in C.UTF-8; refuses another cluster | **Proven** | In-stack suite; self-test `refuse`; the refusal now checks the locale too (unit test: built-in C is refused) |
| --shape=split and --shape=launch | **Proven** | 5 and 9 processes, every /healthz 200 (first round) |
| status at or under 0.6 GB | **Proven** | 387 MB (504 MB with the Vite dev server) |
| THE SLOT, the launcher lock, the use files | **Proven** | Self-test slot, wait, free, kill, names (first round; kill and names again this round); the use-file cleanup regex fixed |
| Compose form | **Not done** | Built, not run (no `.wslconfig`; Docker not allowed). Image smoke runs in CI |
| Stage-0 skeleton on Hobby: shell, CDN, endpoint document, hello game, drain, dump, UTF8, nothing needing Pro | **Proven** | Sections 2 and 6; redeployed three times today (fix 1, fixes 2-6, the release) |
| Secrets: never in a commit, a log line, the client bundle or a document; sealed | **Proven** | check-secrets before every commit; the three secrets sealed; the dumps key rotated; no source map or secret in the served client |
| Cost by the one formula at 6 and 72 hours | **Not done (time)** | Readings: 25 min (U+5 $8.75), 4.5 h ($7.51), the reviewer's 6.43 h ($7.58, the floor). The 72-hour reading needs the skeleton untouched for three days |
| Bucket throughput at 2,000 fetchers (D6) | **Not done: inconclusive** | Section 6 of the capacity report: the run measured the fleet; rerun recipe there |
| docs/capacity report | **Done, corrected** | `docs/capacity/2026-11-12-platform.md` |
| No existing Modal app or volume, no other Railway project touched | **Proven** | Section 2 lists everything created; haulpoint-tms untouched |

## 6. Cloud measurements (D1-D8), short

Details and tables: `docs/capacity/2026-11-12-platform.md`.

- D1 cost: U + $5 = $8.75 over 25 minutes with traffic, $7.51 over 4.5 nearly idle hours (met, against $30;
  the workspace bill about $10.6); the 6 h and 72 h readings not taken.
- D2 Postgres: 18.6; POSTGRES_INITDB_ARGS took effect (UTF8, builtin, C.UTF-8); ALTER SYSTEM accepted, in force
  after one restart.
- D3 overlap: build 2-2.5 min, no pause; standby healthy; SIGTERM 1.4 s after the new one is healthy; 45 s drain
  honoured; requests move to the new deployment at once, 0 errors in 494.
- D4 Postgres restart: the hello role reconnected after 850 ms.
- D5 CDN and mirror: ranged responses never cached (DYNAMIC); whole objects are; mirror mode = slices of
  256 KiB (1.38 bytes per byte needed over the first session; 2 MiB 3.28, 1 MiB 2.20); query strings 404 with
  0 bytes; the origin sees the client address in X-Forwarded-For; boot redirect works; slice MISS 334 ms, HIT
  40 ms to first byte; bucket CORS and ExposeHeaders honoured. From Chrome under COEP against the deployed
  services: bucket first tile decoded 1,262 ms cold, 96 tiles in 582 ms in 4 requests; mirror 2,512 ms, 1,109 ms,
  8 requests; identical bytes. **The bucket's 403 for an expired URL has no CORS headers** (a page sees a network
  error): the pack source now refreshes the list once on a network error from presigned URLs.
- D6 bucket from Modal, 15 minutes per level: 20 fetchers pass (p95 378 ms, 0 errors); 500 pass (p95 233 ms,
  0.018 % errors, 1.07 Gbit/s); **2,000 FAIL** (p95 553 ms, 2.74 % errors, 1.40 Gbit/s).
- D7 derating (job role `derating`, six real regimes of createSim with real terrain, 1/2/4/8 synchronised
  sleep-scheduled workers, 30 s each): Railway (Xeon Gold 5520+, 8 vCPU replica, temporary) per-thread p50 /
  p99 per tick of six world steps 667 / 6,786 us at 1 worker, 625 / 7,126 at 8; this machine 204 / 2,394 and
  397 / 4,319: derating about 3x at one worker, 1.6x at eight; 0.022-0.027 vCPU-seconds per vessel-second on
  Railway (0.010-0.016 here); idle CPU 0.00004 vCPU.
- D8 first session: 577 MB as the browser loads today (tiles 304, sky 135, assets 136), 461 MB with the OPFS
  cache; per-visitor and front-page figures recomputed in the capacity report (23-29 TB and $1,590-1,990 for
  the all-miss mirror day instead of 15 TB and $750-1,125).

## 7. Not done, and why

- **The 6-hour and 72-hour idle cost readings (D1).** They need the skeleton untouched for that long after the
  measurement traffic; this session cannot wait three days. The skeleton is left running at its idle floor
  (as the brief asks); `node deploy/railway/usage.mjs snapshot` at +6 h and +72 h, then `report`.
- **D7 measured on a temporary replica, not on `game` itself**: the benchmark ran in the `ops` service at
  8 vCPU / 8 GB (same hardware class), deleted afterwards, so `game`'s limit never had to be raised and put
  back. Its regimes are whole `createSim` world steps of the six mission states (stepVessel plus the world
  around it), not stepVessel alone as in codebase-audit 3.3, whose touchdown regime on flat stand-in ground is
  not reproduced.
- **The compose suites** (dump and restore in the pinned image, compose Postgres encoding, the VM cap): built,
  not run, by the coordinator's rule (no `.wslconfig` cap).
- **Two browser tests on the local stack** (failover on 429/404/403 against the stand-in, and the terrain hash
  computed in the page) did not complete: the first run found a fixture fault (fixed), the rerun sat behind six
  other agents' runs in the one GPU slot and was cancelled at 10:07 Pacific so that nothing stays running. Both
  behaviours are proven otherwise (Node unit tests; the deployed failover in Chrome; the terrain guard through
  the pack source in Node, 4,000 heights bit-identical). Command in section 5.
- **The recorded trace is 4 minutes, not 10**: the pilot reached orbit in 237 s; the session ends there by
  the brief's own definition of D8 (boot, title, one launch to orbit). A 10-minute trace would add orbit tiles.
- **Levels 0-3 of Earth and the Moon in the boot pack**: 122 MB on disk, five times the 25 MB budget; levels 0-2
  (and 0-1 of height) are in, the rest deferred and listed in `deploy/boot-manifest.json`.
- **Low mips of the cloud map**: none is baked (the cloud coverage map is one 38 MB PNG); a reduced copy is a bake
  product, not tile bytes; listed as deferred.
- **The client does not use the boot pack or the pack source yet** (app-integration-2 and presentation-sweep);
  the boot set measurement therefore holds back the page's own requests beyond it.
- **Autodeploy of shell on its watch paths and builds of game from a `release` branch** need Railway's GitHub
  App (OPEN_QUESTIONS Q5, not authorised): the watch patterns are set on `shell`, but every deploy today is
  `node deploy/railway/provision.mjs deploy <service>` (a clean `git archive` export of HEAD uploaded with the
  logged-in CLI, the documented fallback). `deploy/stage.mjs` and `deploy/rollout.mjs` (ARCHITECTURE 16.2) are
  not part of this brief and do not exist.

## 8. Requests and contract changes

- `docs/requests/platform-delivery-1.md` (open, not blocking): ten unit test files read baked data without
  skipping when it is absent; CI excludes them meanwhile (`.github/workflows/ci.yml`).
- Contract change for the lead: lift `TilePackIndex` (and with it `PackList`, the pack list document) from
  `src/terrain/packIndex.ts` into `src/core/contracts/terrain.ts` (MIGRATION_V2 "after 3.2"). Nothing else in
  `src/core/contracts` was changed; `TileSourceSpec` is used as the lead wrote it.
- New file outside the four named `src/terrain` files: `src/terrain/tileSource.node.ts` (the `fs` kind cannot
  live in the browser-safe module; the coordinator allowed new files there), and `src/terrain/tileSource.test.ts`.
- No open request against this package's paths was found in `docs/requests/`.

## 9. What the next packages must know

**presentation-sweep (tile workers take a TileSourceSpec).** Call `createTileSource(spec)` from
`src/terrain/tileSource.ts` in the worker's init; it returns the existing fetch source for `{ kind: 'fetch' }`
(the plain-file dev path is unchanged) and the pack source for `{ kind: 'pack', packListUrl, cache }`. The pack
source batches what is asked in the same turn: issue a level's requests together, not one awaited after
another. `cache: { kind: 'opfs', maxBytes }` works in workers and on the main thread; in Node it fails every
read with a clear error (by design). `addBootPack(bytes)` serves the boot pack's tiles from memory.

**server-persistence (wave 5).** Put the server roles into `deploy/roles/manifest.ts` (replace the hello entries;
`server/` must not import `deploy/`: your roles receive `RoleContext` from the entry, with the logger, the egress
meter (count `public-docs`, `api` and socket bytes there and add their budgets), the build identity, the HTTP
router and `services.packList` (serve it at `/packs.json` from `api`). The dump role is yours to give the real
schema: it reads `meta.change_seq` (absent today: it logs `dump-no-marker` and dumps every due hour) and
excludes the data of island_jrnl, island_ckpt and usage_hour. The host stack's Postgres is at
`STACK_STATE.postgres.url` (database `fsp`, production's cluster settings and `ALTER SYSTEM` values); the
directory must also refuse a non-UTF8/non-builtin database (the launcher already does). Drain: Railway honours
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS=45` and sends SIGTERM 1.4 s after the new deployment is healthy; on the host
stack a stop is `POST /_ctl/stop` with `x-stack-token: STACK_CONTROL_TOKEN`. A Postgres restart costs a
connected client about 0.85 s.

**deploy-loadtest (wave 6).** The production environment is up at its idle floor: fill it. Tools:
`deploy/railway/provision.mjs` (idempotent runbook: services, deploy a clean export, ops jobs),
`deploy/railway/usage.mjs` (the one formula; the readings log), `deploy/modal/fsp_probe.py` and
`make-requests.ts` (bucket fleet), `tests/browser/platform/deployed.spec.ts` (Chrome against production),
`tests/browser/platform/session-trace.spec.ts` (record a session), `pack-sweep.ts trace-local` (replay a trace
for any mirror addressing). Take the 6 h and 72 h readings first if the lead has not. The mirror runs slices of
256 KiB (`MIRROR_SLICE_BYTES`, on shell and in game's pack list); a ranged mirror is pointless on Railway's CDN
today. The budget guard is the replica limits plus the shell's egress budgets; no usage limit is set.

**app-integration-1 and -2, capability-settings.** The boot pack's contents and order are data
(`deploy/boot-pack.json`); `deploy/boot-manifest.json` says what is in it and what is deferred; the shell serves it
at the endpoint document's `bootPack.url`, immutable, through the CDN. The sky and assets are packed as file sets
(`sky`, `assets`): read them with `file(set, path)` or, for the low mips, `fileRange`. Today the browser loads the
whole sky (135 MB) and every asset (136 MB) in the first session: streaming them on demand would halve a first
visit.

**The lead.** `data/packs` (13.96 GB) is to be kept until `copy_packs` has filled the Modal volume
`fsp-packs` (it runs once the earth upload is complete: `modal run --env fsp deploy/modal/fsp_offsite.py::copy_packs
--pack-list https://game-production-dfc41bff.up.railway.app/packs.json`, see the running log). The terrain guard
was re-recorded in format 2 during this work; the browser terrain check reads its directions from the file.

## Running log

- 2026-11-12 00:40 (Pacific; 08:40 UTC) start. Tree at 6f012fe plus other agents' uncommitted work (cockpit,
  atmosphere, sky-lighting files: not mine). Nothing of this package existed. Disk: 61 GB free on C:.
  Read: STATUS, the brief, PACKAGE_RULES, user-decisions, lead-baseline-v2 hand-off, ARCHITECTURE 6.2, 10,
  13.1, 15.2-15.3, 16, 27, 29.2, 30, hosting-small (all), OPEN_QUESTIONS_V2, PROMPT.
- First finding (measured before any code): levels 0-3 of Earth and the Moon are 122 MB on disk (Earth
  67 MB: height 47.9, albedo 14.3, watermask 2.2, night 1.7, land cover 1.4; Moon 55 MB: height 50.4,
  albedo 4.7). ARCHITECTURE 10.4 puts them in a 25 MB boot pack together with the bundle and the
  definitions; they do not fit five times over. The boot pack is therefore filled by priority inside the
  byte budget and `deploy/boot-manifest.json` lists what is deferred (the brief's own provision).
- 01:01 c01da51: pack format, packer, pack source, createTileSource, bucket stand-in, pack-list service, boot
  builder, upload tools; 18 + 4 unit tests green on synthetic terrain.
- 01:02 the full tile packing (`tools/pack/cli.ts tiles`, bake class) queued; the bake slot is held by
  site-bake (`site-bake-stage`), so it waits.
- 01:08 boot pack built against the stack client build 7bc21a26da2aba3d: 19.97 MB pack + 2.22 MB first-paint
  JS/HTML + 0.23 MB definitions = 22.4 MB of the 25 MB budget. Deferred (do not fit): Earth height level 2
  (9.4 MB) and 3 (35.5 MB), Earth albedo level 3 (10.6 MB), Moon height 2-3 and albedo 3; no low-resolution
  cloud map is baked; no menu yet.
- 01:12 coordinator: no Docker and no `--compose` run this round (no `.wslconfig` cap); the launcher takes
  its own lock under data/stack. The compose form is built and refuses to run without a 6 GB cap.
- 01:12 first stack run hung: `pg_ctl start` under spawnSync on Windows (the server inherits the pipe).
  Fixed (output to a file); `down` cleaned the hung run (launcher, Postgres, ports, slot).
- 01:17 58d520c: roles, entry, launcher; the in-stack suite (9 tests) green: Postgres 18.6 (180006) UTF8 /
  builtin C.UTF-8 ready in 172-393 ms, production settings, advisory lock, fenced write, hard kill of
  Postgres, citext, non-1252 text, endpoint document, boot pack served and verified.
- 01:25 Railway baseline (`railway usage --json`, read 09:25 UTC): workspace "Shrivu Shankar's Projects",
  period 2026-11-02 to 2026-12-02, usage $4.61 so far, estimated bill $8.05, all of it `haulpoint-tms`
  (memory $3.41, CPU $0.46, egress $0.64, volume $0.10). No workspace usage limit is set; an "Agent" target
  (Railway's own agent feature) has a $5 hard limit, untouched.
- 01:26 ABOUT TO CREATE (Hobby plan, approved): Railway project `fable-space-program` (environment
  production); buckets `packs` and `dumps` in US East (iad), $0.015/GB-month: about $0.21-0.30 a month for
  14-20 GB of packs, cents for dumps; services `game` (hello role, limit 2 vCPU / 2 GB), `shell` (static +
  mirror, limit 0.5 vCPU / 0.25 GB, CDN on), `postgres` (Postgres 18 template image, limit 1 vCPU / 0.5 GB,
  5 GB volume at $0.15/GB-month of used space), `dump` (hourly cron, seconds per run). Expected idle usage
  $3-8 a month on the low side of ARCHITECTURE 30 (hello roles are lighter than the real game); this week's
  share about $1-2. Budget guard: per-service replica limits (no hard workspace limit: it would stop
  haulpoint-tms; no soft limit: it is an e-mail alert and the user wants none). Modal: environment `fsp`
  (free), one volume for the pack copy (inside Modal's free storage), app `fsp-probe` on demand.
- 01:20-01:33 CREATED on Railway (project `fable-space-program` 7cc16fa5-1790-44e6-8087-4e75673a5a7a, environment
  production 11958a85-d81f-4639-9d77-90bbef65e27b): buckets `dumps` (56ba9069-0144-4099-b8bf-a6497a9e98f3, S3
  name in deploy/railway/buckets.json) and `packs` (3ca8455f-988e-4425-a9f0-f024512cecfd); the first `packs`
  create raced with `dumps` and left an undeployed, empty bucket (4dad6994-31d6-47e2-865c-1521299558d6, renamed
  `packs-orphan-undeployed`; the CLI cannot delete it because it is in no environment: delete it in the
  dashboard, project settings, buckets). Services postgres 77bea2f1-a875-4eee-8889-c7e43368a7ca (image
  ghcr.io/railwayapp-templates/postgres-ssl:18, 5 GB volume at /var/lib/postgresql/data, limit 1 vCPU / 0.5 GB),
  game c3c9e85c-d3c2-4f72-bf90-86c59ab0929d (limit 2 / 2, draining 45 s, restart Always, health /healthz),
  shell f86d5d8f-67a3-4828-9bca-5ac4707043be (limit 0.5 / 0.25, CDN on), dump c93a9302-50e5-41b6-b21c-631a3bba04f9
  (cron 7 * * * *, restart Never). Domains game-production-dfc41bff.up.railway.app,
  shell-production-b6007648.up.railway.app. Bucket CORS set and read back (AllowedOrigins *, GET/HEAD, Range,
  ExposeHeaders Content-Range/Length/ETag). Uplink measured with the 19.97 MB boot pack: 5.1 s (31 Mbit/s).
- 01:31 the skeleton is UP: Postgres 18.6 (server_version_num 180006), initdb printed "locale provider:
  builtin, default collation: C.UTF-8": POSTGRES_INITDB_ARGS took effect; the hello game connects (UTF8,
  builtin, C.UTF-8); shell healthy with the boot pack loaded from the bucket in one attempt. buildId
  e6f0ba3d7194f245 on game (commit ae74aa7) and shell (41ff282): the bundle did not change between the two
  commits, so the id is the same. Game: upload 40 s, build and deploy 2 min 9 s, no build pause.
- 01:35 coordinator: the launcher keeps its own lock (done: data/stack/.launcher.lock) and writes
  `<build>.use-<pid>` beside the client build it serves (done; removed at teardown, stale ones by `down`).
- 01:35 ALTER SYSTEM on Railway (ops job `pgsettings`): accepted; shared_buffers 128MB -> 96MB and
  max_connections 100 -> 40 pending a restart, max_wal_size 1GB -> 256MB and min_wal_size 80MB -> 64MB at
  once. Postgres restarted with `railway restart` under the connected hello game: the game logged db-lost at
  09:35:43.855 UTC (2.2 s after the command) and db-back 850 ms later.
- 01:36-01:39 packed (cpu class; the bake slot stayed with site-bake): moon 164,874 tiles + 3 files, 27 packs,
  3.39 GB, index 1.66 MB, 7 s; sky 9 files 135 MB, 1 pack; assets 185 files 136 MB, 2 packs; earth 697,346
  tiles + 3 files, 66 packs, 10.30 GB, index 4.55 MB, 62 s. data/packs 13.96 GB. Tile counts equal the terrain
  guard's file counts. Upload to the packs bucket started (35-40 Mbit/s, resumable per pack).
- 01:44 FULL SWEEP green: every promised tile and every plain file of earth and moon through the pack source in
  four modes (whole packs on disk, bucket presigned ranges, mirror ranges, mirror 2 MiB slices; the mirror is
  the stack's shell proxying the stand-in), byte-identical to the fs source: 0 mismatches (earth 10.26 GB in
  123 s, moon 3.39 GB in 39 s). The first attempt hit the shell's own budgets (8 GB a day, 300 MB per address
  in 10 minutes: correct behaviour; the sweep lifts them through EGRESS_MIRROR_BYTES_PER_DAY and
  MIRROR_PER_ADDRESS_BYTES), the second a burst of ~1,000 sockets on Windows: the pack source now keeps at
  most 24 requests in flight.
- 01:43 DEPLOY OVERLAP on Hobby (redeploy of game, same image): the new deployment was healthy 41 s after the
  command; SIGTERM reached the old one 1.4 s later; it logged a heartbeat every second up to 46 s after SIGTERM
  and nothing after: the 45 s drain is honoured.
- CDN (shell, Railway edge den1): a request with Range is never cached (x-cache DYNAMIC every time, also on an
  object the CDN holds whole), and the origin answers it with just the range; whole objects are (2 MiB slice:
  MISS 334 ms first byte, then HIT 40 ms; the 20 MB boot pack MISS then HIT); index.html and endpoints.json
  DYNAMIC (no-cache honoured). So the mirror's mode is SLICES of 2 MiB (the brief's rule); bytes sent per byte
  needed is measured on the recorded session. The origin sees the client's address first in X-Forwarded-For
  and in X-Real-IP behind the CDN (the per-address limit works). Bucket from Node: presigned ranged GET 206
  with CORS (ACAO *), ExposeHeaders honoured (Content-Range readable), preflight 200, a changed date 403.
- 01:45 first-session trace recorded in real Chrome (dev server, /?scenario=lunar-direct&pilot=1, clean
  profile): boot 41 s, EARTH_ORBIT reached 237 s after navigation; 26,999 requests and 590 MB, of which tiles
  26,054 requests and 304 MB, sky 135 MB (8), assets 136 MB (184), definitions 0.22 MB (110), dev-server code
  15.7 MB (642). Trace: docs/capacity/traces/first-session-2026-11-12.json.
- 01:47-01:53 the trace replayed through the pack source against whole packs (docs/capacity/
  trace-replay-2026-11-12.json), with an in-memory stand-in of the OPFS cache (a tile read twice is needed
  once): 26,023 tile reads, 189.5 MB of unique tile bytes. Bucket ranges (64 KiB coalescing gap): 2,508
  requests (10.4x fewer than per file), 1.13 bytes per byte needed; without any client cache 6,137 requests
  (4.2x; 5.5x at a 128 KiB gap). Mirror slices: 2 MiB 3.28, 1 MiB 2.20, 512 KiB 1.66, 256 KiB 1.38,
  128 KiB 1.25 bytes per byte needed: the mirror's slice size is 256 KiB (MIRROR_SLICE_BYTES=262144 on
  Railway; deploy/packs/packList.ts MEASURED_SLICE_BYTES).
- 01:52-01:57 CI on the branch `platform-delivery-ci` (pushed for this; main untouched): green in run
  43195587786 (checks 1m42s, image 2m21s; about 4 runner-minutes a push) after excluding ten unit files that
  need baked data (request platform-delivery-1). CI buildId 5c50250b3dab3d80 at 1443a92; Railway's build of
  game at f624335 (same bundle) reports buildId 5c50250b3dab3d80: the two builds are one.
- 01:57 Modal: environment `fsp` created; secret `fsp-dumps` (the dumps credential, through a deleted temp
  file); the bucket probe started (fsp-probe, ephemeral `modal run`). Smoke: 20 fetchers for 30 s, 2,116
  ranges, 0 errors, first byte p50 243 ms, p95 518 ms.
- 01:57 pgsettings after the restart: every setting in force, nothing pending; the temporary `ops` service
  (c1aebc95-55ee-4da2-95c0-90837faa0a2a) deleted.
- 01:58 retention probe: 240 small objects named like dumps of the last 60 days (marker `retentionprobe`)
  written to the dumps bucket for the next hourly run of the dump role to prune.
- 02:00 boot pack budget on the deployed shell (EGRESS_BOOT_BYTES_PER_DAY=1 for one deployment, CDN purged):
  first request 200 (20 MB, MISS), the next 302 to the presigned bucket copy, which served all 19,969,602
  bytes; the budget restored to its default (1 GB) and shell redeployed at 02:01.
- 02:01-02:35 Modal `fsp-offsite` deployed (nightly `copy_dump`; run once: the dump 20261112T100751Z-none.dump is
  on the volume `fsp-dumps`). The hourly dump at 10:07:51 UTC wrote dumps/20261112T100751Z-none.dump (915 bytes,
  pg_dump 18 against server 18; no `meta` table yet, so no skip marker) and pruned 205 of the 240
  retention-probe objects, keeping 36 (24 hourly + daily + weekly). buildId 5c50250b3dab3d80, as CI's.
- 02:35 every pack uploaded: 100 objects, 13.96 GB in 3,382 s (33 Mbit/s average, 24-40 per object), resumable
  per object; `tools/pack/cli.ts verify`: all 100 present with their sizes. deploy/pack-sets.json lists earth,
  moon, sky and assets (2472dc9); game redeployed with it; `copy_packs` to the Modal volume `fsp-packs` follows.
- 02:37 bucket probe from Modal (moon packs: 21,665 real tile ranges, mean 26 kB; 15 minutes per level):
  20 fetchers (1 container): 71,126 requests, 0 errors, first byte p50 223 ms / p95 378 ms / p99 733 ms,
  16.5 Mbit/s: PASS. 500 fetchers (10 containers): 4,688,661 requests, 0.018 % errors (714 truncated bodies,
  111 timeouts), first byte p50 48 / p95 233 / p99 388 ms, 1.07 Gbit/s sustained: PASS. 2,000 running.
- 02:50 bucket probe at 2,000 fetchers (40 containers): 6,897,002 requests, 2.74 % errors (174,605 truncated
  bodies, 14,451 timeouts), first byte p50 173 / p95 553 / p99 728 ms, 162.5 GB, 1.40 Gbit/s: FAIL on all three
  thresholds (first line of this hand-off and of the capacity report).
- 02:50 `copy_packs` on Modal: all 100 objects of the deployed pack list (13.96 GB) are on the volume `fsp-packs`,
  each verified by SHA-256 against its content address, in about 12 minutes (10:37-10:50 UTC). That is the copy
  outside the production bucket that makes data/packs deletable when the lead says so (the boot pack is not in
  the pack list: it is in the bucket and rebuilt deterministically by `tools/pack/cli.ts boot`).
- 03:18 BOOT SET COLD LOAD (local stack, `--page=build`, shell serving stack:client build 2f3b1ca7d64e52e1 and the
  boot pack it loaded from the stand-in; Chrome, clean context, cache disabled, CDP throttle 50 Mbit/s down,
  20 ms latency): 22.56 MB transferred in **4.05 s** (pass: 8 s), boot pack verified by SHA-256 in the page,
  cross-origin isolated. The run waited 63 minutes for the one GPU slot.
- 03:20 `npm run stack -- status` of the build-page stack: launcher 75 MB, game 71 MB, shell 86 MB, Postgres
  143 MB: 375 MB.
- 03:20-03:30 D7 derating built and run: this machine (bundle, data/tiles) and Railway (`ops` at 8 vCPU / 8 GB,
  terrain through the pack source from the bucket, buildId d85310b07e61351a; the `ops` service
  cbd6d484-99b0-42b3-99a2-0ae58596a37b deleted after the run). Numbers in section 6 and the capacity report.
- 04:53 the packs-and-deployed browser run that waited in the GPU queue since 03:19 died as it got the slot:
  its parent shell had been stopped, and on Windows the orphaned launcher could no longer start the command
  (exit 0xC0000142, STATUS_DLL_INIT_FAILED; pg_ctl too, so the launcher killed the postmaster: the stack went
  down cleanly). Queued again in the other order (the GPU slot first, the stack inside it), so the stack slot
  is not held while the GPU queue is long.
- 06:37 the requeued browser run reached the GPU slot and stopped at once: port 47220 was still held by the
  Postgres of the 04:53 run (the orphaned launcher could not start taskkill either). `npm run stack -- down`
  stopped it; the launcher now stops a Postgres of its own stack name that a dead launcher left running before
  it checks the ports (c.f. the 01:12 lesson: leftovers of one's own name are the launcher's to clean). Queued
  a third time.
- 08:00 the browser suites ran (GPU slot after a 63-minute queue): deployed paths PASS (numbers in section 6);
  main thread and worker PASS; the deployed failover test found that the bucket's 403 "Request has expired"
  carries no CORS headers (the page sees a network error, so the pack source never refreshed the list and fell
  over to the mirror at once) and the OPFS test found entries lost after a reload (the ledger was saved every
  64 puts and unknown files were deleted at open). Both fixed (the pack source refreshes once on a network
  error from presigned URLs; the cache adopts unknown complete entries), unit tests green, the stand-in now
  answers its 403s without CORS like the bucket; the suites are queued again.
- 09:47 the browser suites (third GPU turn): deployed paths PASS (this time the mirror's slices were CDN hits:
  first tile decoded 500 ms on the mirror, 1,853 ms on the bucket), deployed failover PASS (403 seen as a network
  error, one refresh, the mirror; 404, the mirror), main thread and worker PASS, OPFS reload PASS (328 reads
  from the cache, 0 tile requests). The local failover test failed on the stand-in fixture (its 429 switch
  refused the shell's S3 reads too); fixed (switches hit the presigned client path only). The terrain guard
  through the pack source checked in Node instead: 4,000 collision heights bit-identical. The packs spec is
  queued once more for its last two tests.
- 10:07 Pacific: the last browser rerun cancelled in the GPU queue (six runs ahead); no stack, database or
  browser of this package is running; the stack slot is free. Hand-off complete.
- 18:30-20:00 UTC, fix round (13 items from the review): source maps removed from production first (shell
  redeployed and proven at 18:35 UTC); budgets made a hard stop, public bytes metered, pack-source edge cases,
  slice URLs naming S (both services redeployed at 18:47); OPFS cache length checks, errors as misses, one owner;
  the packer's byte verification and release check; secrets sealed (POSTGRES_PASSWORD after a deploy-time probe),
  dumps key rotated, Modal secret without a file; capacity report corrected; CI pinned, PGDG pinned; launcher and
  self-test fixes (self-test 5 of 5); CORS by origin. Then the release after the final bakes: Earth re-packed
  (12 of 72 packs rewritten) and 25 bodies packed, all verified, swept, uploaded (3.81 GB), game and shell
  redeployed at f025da8, proven from outside. Details in sections 0a and 0b.
