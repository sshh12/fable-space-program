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
