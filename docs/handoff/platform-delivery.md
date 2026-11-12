# platform-delivery: hand-off

Wave 3.1 of `docs/WORK_PACKAGES_V2.json`: tile packs and their delivery, the tile-source seam, the boot pack,
the program entry and the static roles, CI and the image, the local stack, the stage-0 skeleton on Railway's
Hobby plan and the first cloud measurements.

This file is the running log while the package is in progress; the sections after the log are filled as the
work lands.

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
- 01:17 58d520c: roles, entry, launcher; the in-stack suite (9 tests) green: Postgres 18.0 (180006) UTF8 /
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
