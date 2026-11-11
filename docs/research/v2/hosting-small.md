# Hosting at small scale (v2): Railway Hobby, an idle floor, the local stack

Research for the user's decisions of 2026-11-11 (`user-decisions.md`, last two sections): about $50 a month
or less at about 5 concurrent players on the Railway **Hobby** plan, growth by configuration, an idle floor of
about $30 acceptable (true scale to zero only where simple and robust), no alerts, and the whole game runnable
locally from one command. Design input only: nothing was deployed, no cloud resource was created, no source,
contract, test, config, data or v1 file was changed.

- Retrieved 2026-11-11 (UTC) from Railway's live documentation and pricing pages, PGlite and embedded-postgres
  documentation, Microsoft's WSL documentation and npm (sources in section 11). Prices are list prices in USD.
- Labels: **[doc]** stated on a provider page fetched for this report; **[staff]** a Railway employee or
  moderator on `station.railway.com`; **[community]** another forum user; **[measured]** observed on this
  machine for this report (Ryzen 9 9950X3D, 61.6 GB, Windows 11, Node 24.16); **[derived]** arithmetic on the
  above; **[assumed]** a planning value the first build wave must replace.
- It builds on `hosting.md` (which looked at Pro) and on ARCHITECTURE_V2 sections 5, 6.2, 10.5, 15, 16, 29.2
  and 30. Where they disagree with the user's decisions, the decisions win; section 10 lists what the lead
  would change in the v2 documents.

---

## 1. Bottom line

1. **Stage 0 runs on Hobby for about $9-22 a month at 5 concurrent players held all month, and $5-10 with
   nobody playing** [derived]. Three always-on services (`game`, `shell`, `postgres`), one bucket, a dump job,
   and Modal with nothing always on. Usage, not the plan fee, sets the bill: Hobby charges
   `$5 + max(0, usage - $5)`.
2. **`game` is one process holding `gate`, `dir`, `api` and `pub`, with the shard's worker isolates as threads
   of it.** Authority, the fenced writer lease and per-island recovery from a worker failure are unchanged.
   What is weakened is one path only: an unplanned crash of the main thread takes the designed
   "crash of everything" path (at most 250 ms re-run per island, two-owner transitions all or nothing) instead
   of "directory restarts while shards live, nothing rolled back". Graceful deploys lose nothing.
3. **The production server does not sleep.** The v2 time model makes sleeping semantically clean: nothing is
   stepped when the universe is empty, and every wall-clock timer can catch up on wake. But the always-on idle
   usage is $3.5-9.7 a month, mostly covered by the $5 the fee already includes, so sleeping would save
   $0-5 a month. The price would be a 5-15 s first visit that can fail with a 502, on a feature Railway itself
   calls a poor fit for WebSocket servers and databases. Instead the process goes **idle-light**: no tick
   loop, no worker isolates, terrain released, documents built only when asked for. The first island after an
   idle spell waits about 1-3 s for a worker and Earth's resident pyramid, hidden behind the menu. True scale
   to zero is used where it is free of risk: Modal, and rehearsal environments that exist only while used.
4. **Hobby facts that change the v2 design** [doc, staff]: volume backups and point-in-time recovery are
   **Pro only**; deploying a private registry image (one image by digest) is **Pro only**; volumes stop at
   **5 GB**; a replica stops at 8 vCPU / 8 GB (48 / 48 per service over 6 replicas); 50 services; 2 custom
   domains; 7-day logs; 3 concurrent builds; Hobby builds can be paused in "Limited Access". So on Hobby the
   only copy of the database outside its volume is our own hourly logical dump to the bucket (recovery point:
   about 1 hour if the volume is lost), and `game` is built by Railway from the repository at a release
   branch.
5. **Tiles cost nothing to serve at this scale.** Packs (14-20 GB) sit in a Railway bucket at
   $0.015/GB-month with free egress and free operations (Hobby cap 1 TB). A new visitor fetches up to 25 MB of
   boot pack from `shell` (CDN on: a hit is free, a miss is $0.00125) and the rest from the bucket for $0. If
   the bucket path failed and all tiles came through `game`, a new visitor would cost about $0.014.
6. **The first limit hit as players grow is money, not a machine.** Every concurrent player held all month
   adds $0.62-1.93 [derived]. Usage passes $20 somewhere between 5 and 23 concurrent players, and from there
   **Pro costs exactly what Hobby costs**: the bill is `max(fee, usage)` on both. That is when to move to Pro,
   which brings backups, PITR and deploys by digest. The lead tells the user first. $50 a month is crossed at
   about 20-70 concurrent players held all month. The first technical limit is the combined process's main
   thread, assumed at 150-300 players. It is lifted by the v2 split on Pro, with an announced freeze of under
   40 s plus the resume window.
7. **Local stack default: host Node processes plus a real, embedded Postgres 18 (`embedded-postgres`), no
   Docker daemon.** Measured here: start in 0.09-0.3 s (4 s for the first `initdb`), about 160 MB, advisory
   locks exclusive between sessions, the fenced write refused for a stale token, committed rows surviving a
   hard kill. Tiles are read natively, which is 36x faster than through a Docker bind mount for the plain-file
   tree. Docker compose (pinned Linux image, the Railway Postgres image, MinIO) is kept for the suites that
   need Linux signals, the pinned build and `pg_dump`: restart, recovery, replay and the image smoke test. The
   VM is capped in `.wslconfig` and started only for those suites. **PGlite is unfit for the stack**: it has
   one session, so a second directory "takes" the same advisory lock. It is fine for in-process SQL unit
   tests.

---

## 2. Railway Hobby: what it allows and costs

### 2.1 Plan and prices

| Topic | Hobby | Source |
|---|---|---|
| Fee and included usage | $5 a month including $5 of usage; resets each cycle, no rollover; bill = $5 + usage above $5 | [doc] plans, pricing |
| The included $5 is per workspace | Shared with every project of the workspace; this account also has `haulpoint-tms` [measured, `railway list`]. If that project already uses $5, the game's usage is billed in full | [doc] + [measured] |
| CPU / RAM | $0.00000772 per vCPU-second ($20 per vCPU-month); $0.00000386 per GB-second ($10 per GB-month); billed on use | [doc] |
| What memory is billed | "the container's cgroup memory.current plus swap, sampled every 30 seconds, with nothing subtracted": **page cache counts** until the kernel evicts it; a replica memory limit makes it reclaim | [staff] 2026-08-13 |
| Egress | $0.05 per GB of service egress, uploads from a service to a bucket included; **private-network traffic is not billed** | [doc]; [changelog, staff] |
| Volumes | $0.15 per GB-month of used space (+2-3 % metadata) | [doc] |
| Buckets | $0.015 per GB-month; **egress and all S3 operations free and unlimited**; Hobby total capacity **1 TB** (uploads beyond fail); private only (presigned URLs or a proxy); region fixed at creation; bucket count per plan not stated | [doc] |
| VM sandboxes (not used) | $50 per vCPU-month and per GB-month | [doc] |

### 2.2 Limits

| Topic | Hobby | Pro | Source |
|---|---|---|---|
| Per service (replicas multiplied) | 48 vCPU / 48 GB, **6 replicas**, so 8 vCPU / 8 GB per replica | 1,000 vCPU / 1 TB, 42 replicas, 24 vCPU / 24 GB per replica | [doc]; per replica [derived], Pro [doc] |
| Services, projects | 50 each | 100 each | [doc] |
| Volumes | **5 GB max**; 10 per project; one per service; **no replicas on a service with a volume**; brief downtime on redeploy; 3,000 read + 3,000 write IOPS; live grow, never shrink | 50 GB default, self-serve to 1 TB; 20 per project | [doc] |
| **Volume backups and PITR** | **Not available** ("require the Pro plan"; the Backups tab says so; a Hobby backup mutation is rejected) | Daily (kept 6 d), weekly (27 d), monthly (89 d), incremental; PITR via pgBackRest WAL archive to a bucket, about a 4-week window, billed as bucket storage + egress | [staff] 2026-09-08; [doc] |
| **Private registry images** | **Not available** ("you'll need to upgrade") | Registry credentials per service (GHCR token with `read:packages`); a source can be pinned `image@sha256:` | [doc]; [staff] |
| Custom domains | 2 | 20 | [doc] |
| Logs | 7 days; 500 lines/s per replica, excess dropped | 30 days | [doc] |
| Concurrent builds | 3 | 10 | [doc] |
| Build pauses | Hobby builds may be suspended during "Limited Access" pauses (rarer than Free) | Not affected | [doc] |
| Image size, retention | 100 GB; 72 h after a deployment is removed | unlimited; 120 h | [doc] |
| Ephemeral disk | 100 GB per replica | same | [doc] |
| Restart policy | Paid plans: any policy, any count (Always, On failure, Never) | same | [doc] |
| Members | 3 per project | unlimited | [doc] |

### 2.3 Networking, CDN, cron, regions (no plan difference stated)

| Topic | Fact | Source |
|---|---|---|
| WebSockets | Over HTTP/1.1; "exempt from these duration and inactivity limits ... can stay open indefinitely, even while idle" | [doc] |
| HTTP | about 11,000 requests/s per domain; 10,000 concurrent connections per service; 10,000 requests per connection; a request may run 15 minutes while data flows, closed after 5 minutes of silence; HTTP/1.1 idle 60 s; 32 KB headers; HTTP/1.1 and HTTP/2; TLS only; no UDP | [doc] |
| TCP proxy | For raw TCP (e.g. a public database port); billed as egress | [doc] |
| Private network | WireGuard mesh per environment, `name.railway.internal`; replicas not individually addressable (and not sticky); buckets reachable over their public endpoint only | [doc]; `hosting.md` |
| CDN | Beta, all plans, free, off by default, per service. Caches GET/HEAD without `Authorization`; static types and **HTML by default** (2 h default TTL, options 30 min to 1 day), JSON only with `max-age`/`s-maxage`; not over 512 MB; stale-while-revalidate honoured; hits use no compute and no egress; whole-service purge (HTML or all, about 10 s); no hit metrics; range requests not documented (a staff reply in July 2026 says fixed) | [doc]; `hosting.md` |
| Cron services | The service starts on a UTC crontab, must exit; at least 5 minutes apart; an overlapping run is skipped | [doc] |
| Deploys | New deployment healthchecked, then the old one gets SIGTERM and SIGKILL after `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (**default 0**); `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` for overlap | [doc] |
| Regions | US West, US East, EU West, Southeast Asia (all "Metal"); plan availability not stated; moving a service with a volume migrates it with downtime | [doc] |

### 2.4 Serverless (formerly App Sleeping)

| Question | Answer | Source |
|---|---|---|
| Available on Hobby | Yes, opt-in, off by default | [staff] 2026-09-08 |
| When a service sleeps | After 5-10 minutes with **no outbound packets**: network requests, database connections and NTP all count; private-network traffic counts and keeps it awake | [doc] |
| How it wakes | The first request from the internet or from another service over the private network wakes it. The first request **may return 502**, and clients should retry. A WebSocket upgrade is an HTTP request, but wake-by-upgrade is not documented | [doc] |
| How long a wake takes | Not documented: "a small delay". Community: 5-10 s (Feb 2026, against < 300 ms awake), 2-5 s before a retry succeeded; a staff reply says possibly longer than 10 s | [doc]; [community] |
| Billing while asleep | "A slept service accrues no compute charges"; egress and volumes still billed | [doc] guide |
| Caveats | "De-prioritizes your workload and in remote cases may require a rebuild"; applies to every replica; takes effect on the next deployment; Railway's guide lists **WebSocket servers with long-lived clients and databases as poor fits**; one report of a serverless MySQL that woke only after a redeploy | [doc]; [community] |
| Whether the process is stopped (SIGTERM) or frozen | Not documented | - |

### 2.5 Postgres on Hobby

| Topic | Fact | Source |
|---|---|---|
| Template | Railway's SSL image on the official Postgres image, private by default, one volume; the image repository builds majors 13-18 (`:latest` = 16), so **pick the major at creation** (18 here, to match the local stack) | [doc] |
| Configuration | The image writes only `$PGDATA/conf.d/*.conf`; `ALTER SYSTEM` (`postgresql.auto.conf`) is ours; it preloads `pg_stat_statements,pgaudit`; SHM 64 MB by default | [doc] |
| Memory floor | Not documented. Community: 30-50 MB idle after a restart to about 300 MB steady; set `shared_buffers` explicitly. Measured in a container here: **57 MB idle** with `shared_buffers=64MB`, 72 MB after 20,000 rows | [community]; [measured] |
| Backups, PITR, HA | Backups and PITR **Pro only**; HA (Patroni) conversion exists and is not needed | [staff]; [doc] |
| Volume cap | 5 GB on Hobby | [doc] |

### 2.6 Usage limits and alerts

- Usage limits exist on every plan. A **custom email alert** at an amount keeps services running. A **hard
  limit** (minimum $10) "will shut down your workloads", and with buckets "bucket access is suspended". Volume
  data is kept. Usage emails go out at 75 %, 90 % and 100 % of a hard limit. [doc]
- **Recommendation (no alerts, per the user):** set no hard limit, since it would take the game offline.
  Bound the worst case with **replica limits** instead, which are configuration and not alerts: `game`
  2 vCPU / 2 GB, `postgres` 1 vCPU / 1 GB, `shell` 0.5 vCPU / 0.25 GB. That caps compute at about $100 a month
  even if everything were pegged all month. Whether to add Railway's own threshold email is the user's choice;
  nothing of ours routes alerts. The metrics the capacity report needs stay (`/metrics`, structured logs). On
  Hobby they are retained 7 days, so a load test copies its numbers into `docs/capacity/` as it runs.

---

## 3. What must still happen when nobody is playing

In the v2 model an empty universe is passive: a passive vessel "is on no clock, is never stepped and has no
timers" (5.1). These are the only things on a timer, with what each needs:

| Timer (base) | When it can be pending with nobody connected | What it needs |
|---|---|---|
| Reconnect grace 120 s, latch and dead-man timers, reservation holds 90 s, ready-checks, helm requests, the resume window (up-time) | Only in the first minutes after the last pilot left | Ends by itself; then everything is passive |
| Unattended runs of pilots who left mid-flight; Reduced-tier debris in atmosphere (paced by a clock) | Minutes after the last pilot left, until each object comes to rest | One worker isolate for minutes; then passive |
| **Fates (U13)**: an unattended run starts when its pacing clock reaches the vessel's horizon | **Yes, while the process runs:** the live and cohort clocks advance at 1x with directory up-time, so a passive vessel on an entry or impact conic reaches its horizon in real time. Orbits clear of every atmosphere have an infinite horizon and never come due | The directory holds `horizon_tick` per vessel, so it schedules a worker and terrain about 60 s before the earliest horizon on a live or cohort clock. Each fate is minutes of one vessel at 3-15 us per step: negligible CPU |
| Pad occupancy and safing (ticks), the 60 s pad disconnect grace and roll-back (up-time) | Only until the last slot ends (at most 300 s + 120 s extension, 600 s up-time cap) | Ends by itself |
| Expiry sweep (wall clock, every 60 s): owner retention 14 d, unowned 48 h, debris 2 h, wrecks 2 h, arc reduction 24 h, empty accounts 90 d | Always | An in-memory pass over the passive index (0.5 kB per vessel); with nothing reserved it can run at any cadence or **catch up on wake**: nobody can observe a removal between sweeps, and the pressure rule cannot trigger while nobody launches |
| Public documents (`live.json`, `status.json`, census) once a second | Only if someone polls | Build on request, cached 1 s; nothing when nobody asks |
| Persistence: partition creation and drops, the dump, lease renewal | Always, trivially | Partitions only while islands exist; dump only when rows changed since the last one; the lease row renewal is one UPDATE every few seconds |
| Modal audit of archived journals; off-site dump copy | Nightly | Seconds on Modal |

**Could it sleep?** Semantically, yes. If the process stopped, directory up-time would freeze, and with it the
live clock, every cohort clock and every fate (5.2: "it does not advance while the universe is down"). Every
wall-clock expiry could catch up in one sweep on wake, and there would be nobody to resume, so the resume
window could be skipped. Two rules would need wording first:

- U19 says "an outage longer than one hour extends every expiry deadline by its length". A planned sleep would
  have to be recorded as not an outage.
- The live clock would drift behind wall time by the total time asleep. That is harmless, but it is a visible
  change from "the live clock tracks wall time".

Mechanically, sleep needs the process to stop sending every outbound packet: no lease renewal, an empty
connection pool, no NTP. So it would release the lease and drain to passive first, then trust an undocumented
stop or freeze and an undocumented wake time. **Not recommended for production** (section 1, item 3). The
process is designed **idle-light** instead:

- after the last island is gone and the grace has ended, terminate the worker isolates;
- release the terrain residency (lazy per-body residency already does this, 10.2);
- stop the tick loop (ticks are scheduled by sleeping, 6.2);
- build documents only on request, and keep one Postgres connection for the lease.

The first menu request or socket after an idle spell starts a worker and loads Earth's resident pyramid:
1,020 tiles, 48 MB from the bucket, about 1-3 s [assumed]. That is done long before a player reaches a pad.

---

## 4. The memory floor (measured on this machine)

A probe built only from repository code (`loadDefs`, `createTerrainProvider` on the fs tile source,
`createSim('lunar-direct')`, 2,400 steps; scripts in the session scratchpad, nothing written to the tree):

| State | Process RSS | Of which | Note |
|---|---|---|---|
| Node 24.16 + tsx loader, nothing loaded | 80-92 MB | heap 12 MB | Bare Node 24 in the Linux image: **43 MB** |
| + definition library | 99 MB | +7 MB | `loadDefs` 26-32 ms |
| + Earth terrain, resident pyramid (levels 0-3 of height and land cover) | 224 MB | 1,020 tiles, **102 MB decoded** in ArrayBuffers | 46 + 2 MB on disk; 398 ms from local disk |
| + `createSim` at the pad, pad region loaded | **283 MB** | tile cache 110 MB | 260 ms |
| + Moon resident pyramid as well | **357-361 MB** | +510 tiles, 68 MB decoded | 49 MB on disk |
| 2,400 steps at the pad | +2 MB | | **11.5-12.7 us per world step** (stack + clamps) |
| One more worker isolate holding the sim code and definitions | +15-50 MB | heap 16-20 MB used, 32 MB total | four isolates: +43-50 MB in all; about 34 MB not returned after termination |

From the research: 375 kB of heap per live 42-part vessel and 87 kB per 9-part lander; 0.5 kB per parked ship
in the directory (`codebase-audit.md` 3.2, ARCHITECTURE 15.2). The v2 budget of 200 MB per worker isolate and
a 1 GB tile store (10.5) is for a loaded shard, not for five players.

**Budgets for `game`** [derived]:

- idle-light: 0.15-0.35 GB;
- 5 players: 0.4-0.75 GB (Earth always; the Moon when someone is there; one or two worker isolates; a tile
  store capped at 512 MB);
- 50 players: 0.8-1.6 GB (two to four isolates).

Railway bills page cache as memory, so on Hobby the shard **does not keep a disk LRU of height packs**. It
reads ranges from the bucket straight into the decoded store (ingress and bucket egress are free), and the
2 GB replica limit makes the kernel reclaim cache.

---

## 5. Stage 0: the deployment for about 5 players (Hobby)

### 5.1 Topology

```
browser ── HTTPS ──> shell     static shell + boot pack (<= 25 MB), COOP/COEP, CDN on, autodeploy on its paths
        ── WSS ────> game      one Node process: gate + dir + api + pub; shard worker isolates as threads
        ── HTTPS ──> game      api (accounts, pack list, planning), pub (live.json, status.json, census), CORS
        ── Range ──> bucket    tile, sky and asset packs by presigned URL   [mirror: game /p/ slices]
private network:  game ── postgres (template, Postgres 18, 5 GB volume)
                  dump (Railway cron, hourly) ── postgres ; dump ── bucket (time-named, pruned by the job)
Modal env fsp:    fsp-audit (nightly), fsp-offsite (nightly copy of the latest dump off Railway),
                  fsp-bake, fsp-probe, fsp-bots (R&D, on demand); nothing always on
```

| Service | Settings |
|---|---|
| `game` | Source: the GitHub repository at a `release` branch the lead moves to the release tag (no private registry on Hobby). Dockerfile with Node pinned by digest. **Autodeploy off**: a deploy is a scripted, ordered rollout. Healthcheck passes in standby. `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=45` (the default 0 would turn every deploy into a crash). Restart policy Always. Serverless off, CDN off, no volume. US East. Replica limit 2 vCPU / 2 GB. One replica. Shard: 1-2 worker isolates spawned on demand, tile store cap 512 MB. Bucket ranges, no disk cache |
| `shell` | Tiny static server (or Railpack static) with COOP/COEP and immutable hashed assets. `index.html` sent `no-cache` so the CDN does not hold it for 2 h. CDN on. Autodeploy with watch paths: **a front-end push never restarts the universe**. Replica limit 0.5 vCPU / 0.25 GB |
| `postgres` | Template on the 18 image. `ALTER SYSTEM`: `shared_buffers=96MB`, `max_wal_size=256MB`, `min_wal_size=64MB`, `max_connections=20`. 5 GB volume. Replica limit 1 vCPU / 1 GB |
| `dump` | Railway cron, hourly: `pg_dump -Fc` of everything except `island_jrnl` and `island_ckpt`, skipped when nothing changed, to the bucket as `dumps/<utc>.dump`; keeps 24 hourly, 14 daily and 8 weekly copies and deletes the rest itself (buckets have no lifecycle rules). Also run once at the end of every rollout's flush |
| bucket | US East. Packs (content-addressed, about 14-20 GB) and dumps. CORS for ranged GET from the shell origin. Uploads of packs from the development machine or Modal (not service egress) |

Railway's own domains (`*.up.railway.app`) suffice. If the user wants a custom domain, Hobby's two cover
`shell` and `game`; a separate `packs` mirror domain would need Pro.

### 5.2 Which roles share one process, and what that costs

| Combination | Authority | Fenced writer lease | Per-island recovery, restart guarantees | Verdict |
|---|---|---|---|---|
| `gate` + `api` + `pub` | None of them decides anything | Not involved | Stateless; restart = reconnect | Share. `pub` loses the CDN at stage 0, because the CDN must not sit on a service carrying sockets until tested. Polling by 5-50 menu viewers is 1-15 requests/s |
| `dir` + `api` + `pub` | `dir` stays the single writer; `api` reads; `pub` serves what `dir` publishes | Unchanged | Unchanged | Share |
| `dir` + `gate` | Unchanged | Unchanged | A `gate` crash is now a `dir` crash: clients reconnect, which they do anyway | Share |
| `dir` + shard as **worker isolates** in one process | Unchanged: islands keep one holder fenced by epoch; the directory orders reservations | Unchanged: advisory lock + token row; two overlapping deployments are safe because the standby loads and writes nothing (28.6) | **A worker crash keeps full per-island recovery** (the directory and the gateway's input buffer survive in the main thread). **A main-thread crash** takes the "crash of everything" column of 15.4: each island restored at its own durable tick, at most 250 ms re-run, two-owner transitions all or nothing, flights held for their pilots. That meets 29.2's crash budget; it loses the zero-rollback directory-restart path | Share, with that stated |
| Shard + `gate` | Unchanged | Unchanged | On a process crash the input buffer dies with the shard, so islands restore at the durable tick, not at the last frame tick | Acceptable at stage 0 |
| `shell` + anything with sockets | - | - | A front-end deploy would restart the universe | **Do not share** |
| Two directories | Never: one writer per lobby | The lease makes the deploy overlap safe | - | - |
| Postgres + anything | - | - | A volume service cannot overlap deploys | Own service |

The alternative is the v2 split topology on Hobby at minimal sizes: `gate`, `dir` (+`api` +`pub`), `sim-1`,
`shell`, `postgres`. It costs about $2-5 a month more [derived], for about 0.2-0.4 GB more of Node runtimes. It
keeps the directory-restart path. But on Hobby every service is built separately from the repository, because
there is no private registry. Journals are bound to the build, so those builds must be shown byte-identical (a
bundle fingerprint checked at registration). It also needs a scripted rollout across services from day one.
**Recommended: the combined `game` at stage 0, and the split together with Pro (stage 2), where one image is
deployed by digest everywhere.** If the main thread binds before that, the gateway can move to a child process
in the same container (`cluster`, about 50 MB) without a new service.

Deploy and lease mechanics for `game`:

1. The lead's rollout script triggers a deployment.
2. The new process passes its health check in **standby** (no lease, nothing loaded); Railway routes new
   connections to it and sends SIGTERM to the old process.
3. The old process freezes clocks at a tick boundary, writes final checkpoints, flushes, runs the dump and
   releases the lease, all inside the 45 s drain.
4. The new process takes the lease (the token increments), runs the decode sweep and restores islands; the
   clients it was holding with `Notice restart` resume.

Freeze target as in 29.2: under 40 s plus the resume window. A **Postgres restart** (template update, PITR
enable later) drops the lease session. The directory must then freeze, reconnect, re-take the lease and
resume. That is a requirement for `server-persistence` that the split design never had to state.

### 5.3 Persistence on Hobby

- Sizes at 5-50 players: journal about 0.14 kB/s per player kept 2 h (5-50 MB); checkpoints for 15 minutes;
  passive vessels 5-25 kB each; `event_log` needs a retention rule. Altogether 0.3-3 GB including WAL capped at
  256 MB [derived]. The 5 GB volume holds; it becomes the first data limit only if retention is missing.
- **Copies.** The volume is one copy with no platform backup on Hobby. The hourly dump to the bucket is the
  recovery point: up to about 1 hour of directory state if the volume is lost. Flights in progress restart from
  their last passive record (15.3). The nightly Modal copy keeps a third copy off Railway. On Pro, daily
  backups and PITR (minute-level) are switched on (stage 1).
- The dump job uses the Postgres image's own `pg_dump`, so the client matches the server major. Upload egress
  is a few MB to tens of MB a day at this scale: cents.

### 5.4 Front end and tiles at small scale

| Item | Bytes per new visitor | Served by | Cost per new visitor |
|---|---|---|---|
| Shell, bundle, definition library, boot pack | **<= 25 MB** before the title (29.2) | `shell` with CDN | $0 on a hit; $0.00125 on a miss |
| Sky data, assets, regional tiles, calibration data | about 275 MB (the 300 MB planning figure; measured in wave 3) | bucket, presigned | **$0** |
| The same if the bucket path fails for that visitor | 275 MB | `game` `/p/` slices | $0.014 |
| A 30-minute session's socket | 2.5 kB/s planning average, 6 kB/s cap | `game` | $0.0002-0.0005 |
| Return visit | changed content only (OPFS keyed by content hash) | - | about $0 |

- Storage: packs about 14 GB today and at most 20 GB with the 30 extra bodies (10.1, 29), so
  $0.21-0.30 a month, far inside Hobby's 1 TB. The plain-file tree (862,000 files) is never uploaded.
- At 5 concurrent players with 30-minute sessions and 15 % new, there are about 36 new visitors a day
  (1,080 a month) [derived from `hosting.md`'s assumptions]. All their tile bytes are free on the bucket path.
- Throughput risk at this scale: none worth a test beyond correctness. The forum report of slow signed GETs
  was at 100 concurrent fetches. Wave 3 still checks CORS for ranged GET under COEP and cold first-byte times.
- Netlify is not needed at this stage (OPEN_QUESTIONS Q3 default A): `shell` on Railway costs about $0.5 a
  month.

### 5.5 Modal at small scale

Starter: $0 a month plus usage, with a $30 monthly credit, 100 containers and 5 cron jobs for the whole
workspace (`hosting.md`). There is nothing always on. In the new `fsp` environment:

- `fsp-audit`: a nightly replay of the sampled journals (seconds at this scale);
- `fsp-offsite`: a nightly copy of the newest dump from the bucket (free bucket egress) to a Modal volume
  (first TiB free).

Both are inside the credit: **$0**. Bakes, probes and bot rehearsals are R&D on demand. The workspace's four
existing apps in `main` are untouched [measured, `modal app list`].

---

## 6. Monthly cost

Assumptions:

- N concurrent players held **all month** (730 h), which is the v2 convention.
- Per player: CPU 0.0055-0.025 vCPU plus 0.002 for the gateway (29.2); socket egress 2.5-6 kB/s.
- New visitors: N x 216 a month (30-minute sessions, 15 % new).
- Railway list prices from section 2. "Low" and "high" span the measured and conservative figures of
  ARCHITECTURE 30 and the memory budgets of section 4.

| Line | 0 low | 0 high | 5 low | 5 high | 50 low | 50 high |
|---|---|---|---|---|---|---|
| `game` memory | 0.2 GB $2.00 | 0.45 GB $4.50 | 0.4 GB $4.00 | 0.75 GB $7.50 | 0.8 GB $8.00 | 1.6 GB $16.00 |
| `game` CPU | 0.005 vCPU $0.10 | 0.02 $0.40 | 0.04 $0.80 | 0.145 $2.90 | 0.395 $7.90 | 1.37 $27.40 |
| `shell` memory and CPU | $0.45 | $0.85 | $0.55 | $0.90 | $0.60 | $1.20 |
| Postgres memory | 0.06 GB $0.60 | 0.25 GB $2.50 | 0.1 GB $1.00 | 0.3 GB $3.00 | 0.2 GB $2.00 | 0.5 GB $5.00 |
| Postgres CPU and volume | $0.10 | $0.35 | $0.20 | $0.60 | $0.55 | $2.05 |
| Bucket (16-25 GB) | $0.24 | $0.38 | $0.24 | $0.38 | $0.30 | $0.40 |
| Socket egress | $0 | $0 | $1.64 | $3.94 | $16.40 | $39.40 |
| Boot pack via `shell` (CDN all hits / all misses) | $0 | $0.50 | $0 | $1.40 | $0 | $13.80 |
| `api` and `pub` responses | $0 | $0 | $0.10 | $0.50 | $0.50 | $2.00 |
| Dumps (cron and upload egress) | $0 | $0.20 | $0.20 | $0.70 | $0.30 | $1.50 |
| Modal | $0 | $0 | $0 | $0 | $0 | $0 |
| **Usage** | **$3.5** | **$9.7** | **$8.7** | **$21.8** | **$36.6** | **$108.8** |
| **Bill on Hobby** ($5 + usage above $5) | **$5.0** | **$9.7** | **$8.7** | **$21.8** | **$36.6** | **$108.8** |
| Bill on Pro ($20 + usage above $20) | $20.0 | $20.0 | $20.0 | $21.8 | $36.6 | $108.8 |
| Worst case: every tile through `game` because the bucket path failed | +$0 | +$0 | +$14.9 | +$14.9 | +$148.5 | +$148.5 |

- A realistic small pattern (5 players for 4 evening hours, idle otherwise) is the idle floor plus a sixth of
  the per-player lines: about **$5-11 a month**.
- **Idle floor $5-10** includes the fee, against an acceptable $30. If `haulpoint-tms` already uses the
  workspace's included $5, the game adds its full usage: $3.5-9.7 idle.
- Each concurrent player held all month adds **$0.62-1.93**. Socket egress is 40-50 % of that and CPU about
  a third.

**What is hit first as players grow:**

1. **Usage reaches $20** at about 5-23 concurrent players held all month. Pro then costs nothing extra and
   brings backups, PITR and deploys by digest: the moment to upgrade (the lead tells the user).
2. **$50 a month** at about 20-70 concurrent held all month.
3. The first technical limit is the combined process's **main thread** (sockets, directory, documents) at
   50 % utilisation: assumed about 150-300 players, from 0.002 vCPU per connection and per-tick batching; it
   must be measured.
4. Hobby's 5 GB volume, only if retention is missing.
5. 8 vCPU per Hobby replica: about 6 worker threads, roughly 800-1,000 players on the conservative figure.
6. Then the v2 order of 29.2, with launch slots (768 an hour) first at about 400 concurrent launching once
   per session.

---

## 7. Scale-up stages (same code and data; configuration and deploys)

| Stage | When | Exact steps | Freeze | Cost |
|---|---|---|---|---|
| **0. Hobby, combined** | Now | Create project `fable-space-program`, environment `production`, services as 5.1; upload packs; Modal environment `fsp` with the two nightly jobs | - | $5-10 idle; $9-22 at 5; $37-109 at 50 (section 6) |
| **1. Pro, same topology** | Measured usage at or above about $20 a month; or the volume past 4 GB; or the user wants backups or PITR sooner (+ up to $15 a month) | The lead tells the user. The user upgrades the **workspace** (it covers `haulpoint-tms` too). Then: (1) switch on daily and weekly volume backups and PITR on `postgres` (PITR may restart it; `game` freezes, reconnects and re-takes the lease); (2) grow the volume live to 20 GB; (3) move `game` from building from the repository to the CI image by digest (registry credentials, `read:packages`); (4) 30-day logs come with the plan | Seconds (Postgres restart), or none | `max($20, usage)` + PITR about $0.3-1 (WAL in a bucket, small egress) |
| **2. Pro, v2 split base** | `game` main thread above 50 % at peak (measured), or near its measured player limit (assumed 150-300), or gateway and shard must deploy separately | (1) Create `gate`, `dir` (with `api` and `pub`), `sim-1` (workers from the measured knee) from the same digest, idle in standby; give `pub` its own service with CDN when menu viewers are many; add `packs` (mirror + CDN, own domain) only if the bucket path underperforms. (2) Announce a freeze. (3) Rollout: `game` freezes, checkpoints, flushes, dumps and releases the lease; `dir` takes the lease and runs the decode sweep; `sim-1` registers and restores islands from checkpoints (same build); `gate` accepts. (4) Point the shell's endpoint list at `gate` (a `shell` deploy, or DNS with a custom domain). (5) Remove `game` | Under 40 s + 30 s resume window (target of 29.2, measured in the rollout test) | About $3-6 a month more than stage 1 at equal load; e.g. 200 concurrent all month about $130-400 [derived] |
| **3. Pro, v2 launch topology** | An announced launch or measured admission queueing | v2 16.2 Launch: `sim-1..K`, `gate` x 3+, `pub` x 2, `packs` x 4, Postgres to 100 GB; the scale controller inside the Q6 ceiling. It posts **no alerts** (user decision); actions are logged and shown on `/ops` | None (adds services and replicas) | ARCHITECTURE 30: 500 concurrent $420-1,020 a month; a front-page day +$105-345 |

Each step keeps committed state. Stage 2 is the only topology change; it is the graceful path of 15.4, and the
user accepted an announced freeze for it.

---

## 8. The local stack

### 8.1 What was measured

| Option | Measured here | Fidelity to production |
|---|---|---|
| **(a) docker compose: real Postgres + roles in the pinned image** | Docker Desktop 29.6.2 on WSL 2.7.3 was **already running**: started at 05:58Z by another process, not by this task, and left running. Its log: "engine linux/wsl is running after **10.95 s**". The VM sees 30.9 GB (50 % default, no `.wslconfig`); with no container running it used 1.0 GB plus 1.6 GB cache, and `vmmemWSL` held 3.3-4.7 GB on the host (the Ubuntu distribution was running too). Postgres 16 container (image local): ready in under 1 s including `initdb`, **57 MB idle**, 72 MB with 20,000 rows; advisory lock exclusive across sessions; after `docker kill -s KILL` it restarted in 0.76 s with the committed row present. Bare Node 24 container: 43 MB; the local `node:24-bookworm-slim` is **24.20.0** against the host's 24.16.0. **Bind-mount reads of the plain-file tiles: 7,654 files (154 MB) in 13.9-14.9 s, against 0.39 s natively (36x slower)**. Large files: 128 MB in 0.76 s (170 MB/s); 200 x 64 KB range reads in 0.47 s. Over HTTP from a container to a host Node server: the 7,654 tiles in 2.7 s (0.7 s host to host) | Highest: the pinned Linux build (journal replay is defined on it), real SIGTERM and SIGKILL, the Railway Postgres image itself, `pg_dump` and `pg_restore` |
| **(b) host Node processes + embedded store** | **embedded-postgres 18.6.0-beta.19** (npm 2026-10-30; real PostgreSQL 18.6 Windows binaries, MSVC build; versions 14-18): `initdb` 3.96 s once, then start in 0.09 s (0.30 s after a hard kill, with crash recovery); about **160 MB** working set over its processes; two sessions: `pg_try_advisory_lock` true then **false**; a fenced lease write affects 1 row for the holder and **0 rows** for a stale token; declarative partitions work; a committed row survives `taskkill /f`. Caveats: its `stop()` on Windows is itself `taskkill /f` (use the bundled `pg_ctl stop -m fast`); the Windows bundle has **no `pg_dump`/`pg_restore`/`psql`**; the "beta" tag is the package's versioning scheme. **PGlite 0.5.16** (PostgreSQL 18.6 in WASM): opens in 0.2-1.3 s, **575 MB RSS** per process; one exclusive session, so `pg_try_advisory_lock(42)` is true **twice** and a lease contest cannot be expressed; `pglite-socket` 0.2.19 multiplexes many clients onto that one session ("not all use cases are guaranteed to work"), so two clients' transactions would share a session; a committed row survived a hard kill; **a second process opened the same data directory while the first held it, without error** | Real Postgres semantics with embedded-postgres (same major, Windows build); host Node is not the pinned build; Windows cannot deliver SIGTERM between processes (drain by control message) |
| **(c) hybrid: Postgres in one container, roles on the host** | The Postgres numbers of (a) plus the Docker VM floor (about 1 GB used + cache), with the roles as in (b) | The Railway Postgres image exactly; roles as (b) |

### 8.2 Recommendation

**The one-command stack (`npm run stack`, heavy class `stack`) defaults to (b): host Node processes and
embedded-postgres 18.** It starts:

- Postgres in a stack-owned data directory;
- the roles in the production stage's topology (combined `game` by default, `--split` for gate, dir, sim, api
  and pub as separate processes over the TCP transport);
- the existing dev server for plain-file tiles and a small HTTP Range server for packs;
- N Chrome clients when a test asks for them.

Reasons, all measured above:

- No daemon to start and about 1-3 GB less memory than the Docker VM on a machine that crashed under combined
  load. The browser tests need that memory and the GPU.
- Postgres starts in well under a second.
- Native tile reads: the plain-file tree through a bind mount is 36x slower.
- No image rebuild for every edit.
- Real Postgres semantics where the v2 design depends on them: the advisory lock and the fenced token, real
  transactions for the 250 ms batches, partitions, crash recovery. These are exactly what PGlite cannot give.

The same `DATABASE_URL` contract lets the stack use the Postgres container of (c) instead
(`--db=docker`). That is the fallback if embedded-postgres misbehaves on a machine, and it gives the exact
Railway image when a test needs it.

**Docker compose (a)** (`deploy/local/compose.yml`: the pinned role image, `postgres-ssl:18` or `postgres:18`,
MinIO) is started only for the suites that need it, and stopped after:

- **Tiles in compose:** packs bind-mounted (large files read at 170 MB/s), or plain tiles served to the
  containers over HTTP by a host process. Never the plain-file tree through a bind mount.
- **Cap the VM** in `%UserProfile%\.wslconfig`, which Docker Desktop's WSL 2 backend obeys. It applies to
  every WSL 2 distribution and takes effect after `wsl --shutdown`, which stops Docker and Ubuntu, so the user
  applies it when nothing runs:

```
[wsl2]
memory=6GB
processors=8
swap=2GB
[experimental]
autoMemoryReclaim=dropCache
```

### 8.3 Which tests need which

| Suite (ARCHITECTURE 28) | Needs | Why |
|---|---|---|
| 28.1 unit, 28.2 universe, 28.3 mission | Nothing (in-process) | No database; SQL and migration unit tests may use PGlite in-process |
| 28.2 lane equivalence and migration (`tests/net/server`) | Host processes (b) | Executors only; no signals or dumps |
| 28.4 `tests/net` latency matrix, 2-6 headless clients | **(b) by default**; the rows that kill a process run in (a) | Drain by control message works on Windows; a SIGKILL or SIGTERM row needs Linux |
| 28.5 real browsers (2-6 Chrome, GPU) | **(b)** | Memory and GPU for the browsers; under the `gpu` gate |
| 28.6 restart, recovery and expiry: graceful rollout, two overlapping directories, SIGKILL of shard and directory, decode sweep, restore from the bucket dump | **(a)** | Linux signals, the pinned build that replay is defined on, `pg_dump` and `pg_restore` of the production major. Expiry with an injected wall clock can run in (b) |
| 28.7 local load fallback (up to about 200 bots, no capacity claim) | (b), under the heavy gate | Least memory |
| The image smoke test before every deploy | **(a)** | It is the artefact Railway runs |
| `platform-delivery` pack and upload scripts | (b) for the pack source; (a) MinIO for the S3 upload and presign scripts | The real bucket is measured in wave 3 |

This changes the default of 28.4 and the `server-persistence` brief, which put all role processes in the
pinned image. The lead decides (section 10).

---

## 9. Uncertain: to measure in the first build wave

1. Billed memory of `game` and `postgres` on Railway (cgroup memory including page cache), idle-light and with
   5 bots, against the 0.15-0.75 GB and 0.06-0.3 GB budgets; idle CPU billed for both.
2. That the template accepts `ALTER SYSTEM` for `shared_buffers` and `max_wal_size`, and which major it
   creates; pin 18 on both sides.
3. The deploy overlap of `game` on Hobby: standby healthcheck, SIGTERM timing, the 45 s drain, the lease
   hand-over, the freeze duration, and where clients connect during the overlap.
4. A Postgres restart under a live `game`: freeze, reconnect, lease re-taken, nothing lost.
5. Main-thread utilisation of the combined process per connected bot (50-200 bots); this sets the stage 2
   trigger.
6. Presigned ranged GET with CORS under COEP from Chrome; cold first-byte time from the bucket for the boot
   pack against `shell`'s CDN, which decides the mirror order; the bytes and requests of a recorded first
   session (replaces 300 MB and the 275 MB in section 6).
7. Whether a Railway build from the repository is paused in "Limited Access", and the build time of `game`.
8. Whether the workspace's included $5 is already used by `haulpoint-tms`.
9. Time from the first request after an idle spell to a playable island: worker spawn plus Earth's pyramid from
   the bucket (assumed 1-3 s).
10. embedded-postgres across machines (it worked here; the Windows bundle lacks dump tools) and Docker Desktop
    cold start with the `.wslconfig` cap (10.95 s seen once, uncapped).
11. Serverless wake time and behaviour (stop or freeze, wake by WebSocket upgrade), **only** if a rehearsal or
    staging environment is ever left standing with Serverless on instead of being deleted.
12. Whether Railway's CDN passes WebSocket upgrades: matters only if a service carrying sockets ever gets the
    CDN, which this design avoids.

---

## 10. What this implies for the v2 documents (for the lead; not edited here)

- **Decision 45 and 16.2.** "Always in the split topology" becomes three steps:
  - stage 0, Hobby, combined `game` + `shell` + `postgres` + bucket + `dump` cron;
  - stage 1, Pro with the same topology;
  - stage 2, the split base.
  The move to the split is the announced freeze the user accepted. The v2 base row of 16.2 becomes stage 2.
  Section 30's 20-player column ($90-115) is replaced by section 6 here.
- **15.3 copies.** On Hobby there are no volume backups: hourly dumps (skipped when unchanged) plus the Modal
  off-site copy. Daily backups and PITR from stage 1.
- **15.4.** Add "Postgres restarted under a live directory" to the recovery table.
- **5.2 and U19.** No sleep is designed. If one ever is, a planned sleep must be defined as not an outage.
- **6.2, 10.5.** Idle-light behaviour: workers and terrain on demand, no disk LRU of height packs on Railway,
  and fates scheduled from `horizon_tick`.
- **16.2 controller and 27.** No alert routing; keep metrics and logs; on Hobby copy capacity numbers into
  `docs/capacity/` during runs (7-day logs).
- **28.4 and `server-persistence`.** Host processes plus embedded-postgres by default; compose for 28.6, replay
  on the pinned build and the image smoke test.
- **OPEN_QUESTIONS.**
  - Q1 budget becomes "about $5-22 a month standing at 0-5 players on Hobby".
  - Q2 becomes "Hobby now, Pro when usage reaches about $20 a month or backups are wanted".
  - Q18 (alert destination) is withdrawn.
  - New: whether to set a Railway threshold email (user's choice) and the replica limits of 2.6.

---

## 11. Sources

Railway (fetched 2026-11-11):

- `railway.com/pricing`; `docs.railway.com/reference/pricing/plans`; `docs.railway.com/pricing/cost-control`;
  `docs.railway.com/reference/app-sleeping`; `railway.com/guides/cut-idle-costs-serverless`;
- `docs.railway.com/networking/public-networking/specs-and-limits`; `docs.railway.com/reference/scaling`;
  `docs.railway.com/reference/regions`; `docs.railway.com/reference/private-networking`;
- `docs.railway.com/reference/volumes`; `docs.railway.com/reference/backups` and `/volumes/backups`;
  `docs.railway.com/volumes/point-in-time-recovery`; `docs.railway.com/guides/postgresql`;
  `github.com/railwayapp-templates/postgres-ssl`;
- `docs.railway.com/guides/storage-buckets`; `docs.railway.com/storage-buckets/billing`;
  `docs.railway.com/networking/cdn`; `docs.railway.com/reference/cron-jobs`;
  `docs.railway.com/reference/deployments`; `docs.railway.com/deployments/restart-policy`;
  `docs.railway.com/builds/private-registries`.

Railway Station threads:

- "Volume back ups and cold starts" (staff, 2026-09-08: backups Pro only, Serverless opt-in on Hobby);
- "Hard limit resource usage + backups" (2025-08-05);
- "Railway Postgres PITR backup leaves 6 GB page cache" (staff, 2026-08-13: billed memory is cgroup
  memory.current);
- "Postgress memory usage" (2026-03-26);
- "Serverless to resume takes 10 secs" (2026-02-19);
- "Docker image digest pinning" (moderator, 2026-09-02);
- "Idle background-worker container hard-recycled" (2026-07-21);
- search summaries on private-network egress (the changelog of 2024-07-19 and staff replies: not billed).

Local stack:

- `pglite.dev/docs/` (overview, API, `pglite-socket`); `github.com/leinelissen/embedded-postgres`;
  npm registry metadata for `@electric-sql/pglite`, `@electric-sql/pglite-socket`, `embedded-postgres`,
  `@embedded-postgres/windows-x64`;
- `learn.microsoft.com/en-us/windows/wsl/wsl-config` (updated 2026-10-16).

Measured on this machine:

- probes in the session scratchpad: the memory probe through `tools/dev/heavy.mjs --class=cpu`; Postgres,
  Node and Alpine containers from local images, removed afterwards; embedded-postgres and PGlite in an
  isolated scratch directory, deleted afterwards;
- `docker info`; the Docker Desktop host log; `wsl --version`; `railway whoami`; `railway list`;
  `modal environment list`; `modal app list`.

Repository: `docs/ARCHITECTURE_V2.md`, `docs/OPEN_QUESTIONS_V2.md`, `docs/WORK_PACKAGES_V2.json`,
`docs/research/v2/hosting.md`, `docs/research/v2/codebase-audit.md`,
`docs/research/v2/proposal-server-simulates.md`, `docs/research/v2/user-decisions.md`,
`src/terrain/provider.ts`, `tools/sim/realWorld.ts`, `data/tiles/*/manifest.json`.
