# Hosting research (v2): Railway, Netlify, Modal

Research for the v2 redesign (multiplayer, persistence, whole solar system). Design input only: nothing was
deployed, no cloud resource was created, no existing file was changed.

- Retrieved 2026-11-10 from the providers' live documentation and pricing pages (list in section 12) and from
  read-only CLI calls on this machine. Prices are list prices in USD.
- Confidence labels used below: **[doc]** stated on a provider page fetched for this report; **[measured]**
  observed with a request or CLI call made for this report; **[community]** provider forum thread, not
  official documentation; **[assumed]** an estimate of ours that a load test must replace.
- Constraint from `docs/research/v2/user-decisions.md`: build on Railway, Netlify and Modal; find the tile
  delivery path inside those three; AWS only as a last resort with cost numbers for both options; anonymous
  identity; the client/server compute split is a first-class decision with numbers.

---

## 1. Bottom line

1. **Railway is the only one of the three that can host the authoritative simulation.** WebSockets on Railway
   have no duration or idle limit, compute is billed per second of actual use ($20 per vCPU-month, $10 per
   GB-month), a replica can be 24 vCPU / 24 GB on Pro, and Postgres, private networking and object storage are
   in the same project. Modal costs 3x list for non-preemptible CPU, caps a container at 24 h and routes
   function inputs through us-east; Netlify's long-lived "Server" product is in Early Access with 3 instances,
   "a couple of hundred" WebSockets per instance and an 8 h instance lifetime.
2. **Tile data fits inside the three, on a Railway storage bucket.** Bucket storage is $0.015 per GB-month,
   bucket egress and S3 operations are free, and presigned URLs live up to 90 days. This is the only path in
   the three where a 15 TB day does not cost money. It requires **packing tiles into range-readable archives**
   (a bucket is private: one presigned URL per object, so 862,000 objects cannot be addressed one by one) and
   it has one unresolved risk: an unanswered community report of throughput collapse at high concurrency. It
   must be load-tested before launch, with a Railway-CDN gateway as the fallback path.
3. **Netlify is useful only for the static shell** (HTML, JS, CSS: a few MB). Its bandwidth costs 20 credits
   per GB ($0.133 per GB at the Pro recharge rate) and requests cost 2 credits per 10,000; the HN day of tiles
   would cost about $2,000 in bandwidth plus about $1,250 in requests there. On the Free plan the site is
   **paused** when 300 credits (15 GB) are used up. A Railway static service is a complete substitute (topology
   T2) if Netlify credentials are not provided.
4. **Modal is the elastic tier**: load-test bot fleets, data bakes, deterministic replay audits, heavy planners.
   Preemptible CPU at $0.0000131 per physical core-second makes a one-hour 5,000-bot rehearsal cost about $13
   on Modal plus about $9 of Railway usage on the receiving side.
5. **The simulation must run across many processes and several machines from the first design, whatever the
   compute split.** Node integrates on one thread; at the assumed cost one vCPU carries about 33 integrated
   vessels. 5,000 simultaneous ascents are about 215 vCPU if the server integrates everything (nine 24-vCPU
   replicas, about $160 for the day), about 60 vCPU if clients integrate isolated vessels under audit. Cost is
   not the constraint; the per-replica ceiling, the absence of autoscaling and the absence of sticky routing are.
6. **At sustained load the largest line on the bill is WebSocket egress** ($0.05 per GB): every 1 kB/s of
   average downstream per connected player costs $0.13 per player-month. 500 players at 3 kB/s is $197 a month,
   comparable to their CPU ($80-250 depending on the compute split).
7. **Monthly cost of the recommended topology** (section 9): about $70-75 quiet (20 concurrent), about
   $490-710 at 500 concurrent held all month, and about $140-275 extra for an HN day (5,000 concurrent,
   50,000 visitors, 15 TB of tiles). The ranges span the compute split. Worst case if the free tile path fails
   on the day and tiles fall back to billed Railway egress: +$750.
8. **No provider outside the three is needed at the stated loads.** Hugging Face is a usable free mirror of the
   packs, not a primary. An outside CDN is worth asking for only if the bucket throughput test fails; the
   numbers for that case are in section 5.6.

---

## 2. What has to be hosted (corrected numbers)

| Workload | Facts from the repository |
|---|---|
| Tile data | **[measured, hand-offs]** Earth 10.30 GB in 697,349 files; Moon 3.46 GB in about 164,876 files; sky 0.135 GB in 8 files. **Total about 13.9 GB in about 862,000 files**, average 16 KB. The briefing figure of "about 400,000 files" is low by a factor of two. 414,000 of the Earth files (water mask, night lights, land cover) average under 2 KB. Per Earth tile coordinate the five layers total about 72 KB, of which height (52 KB) and albedo (18 KB) are 97 %. |
| Height layers only | 7.38 GB (Earth) + 2.27 GB (Moon) = 9.65 GB. This is all the simulation server needs for terrain collision. |
| Growth | Placeholder bodies need global levels only; at levels 0-5 a layer is 8,190 tiles per body. Thirty bodies with two layers add about 0.5 M files and a few GB in the plain layout. |
| Shipped assets | `public/assets` 37 MB (audio 11, terrain 7.3, vehicle 19); the built shell is small. Sky data 129 MB on disk is fetched by every player. |
| Page isolation | The dev server sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (`tools/server/dataPlugin.ts`). **Every cross-origin tile or asset response in production must carry CORS headers**, and the shell host must send the same COOP/COEP headers. |
| Simulation | Pure TypeScript, no DOM, fixed 1/120 s step, about 0.1 ms per step for one vessel on this machine (Ryzen 9 9950X3D), per `ARCHITECTURE.md` decision 15. Rails propagation is closed-form and effectively free. |

Sizing assumptions used in every estimate below. All **[assumed]**; the load test replaces them.

| Symbol | Value | Basis |
|---|---|---|
| CPU per integrated vessel | 0.03 vCPU | 0.1 ms x 120 Hz = 1.2 % of a 9950X3D core, derated 2.5x for a shared cloud hyperthread |
| Integrated objects per connected player | 0.75 normal, 1.35 on an HN day | half the players integrating (ascent, burns, proximity, atmosphere) plus debris; on an HN day nearly everyone is launching |
| Network CPU per connection | 0.002 vCPU | Node `ws`, about 45 small messages per second per player |
| Downstream bitrate per player | 3 kB/s average | delta-compressed, interest-managed snapshots; rails objects sent as elements on change |
| RAM | 150 MB per process + 0.5 MB per player + 1-2 GB terrain cache + 20 kB per dormant ship | |
| Tile bytes per new visitor | 300 MB | from the task statement |
| New visitors | 150 a day quiet, 3,000 a day busy, 50,000 on the HN day | 30-minute sessions, 15 % new; gives tile egress of 1.35 TB, 27 TB a month and 15 TB in a day |

---

## 3. Platform fact sheets

### 3.1 Railway

| Topic | Fact |
|---|---|
| Plans **[doc]** | Hobby $5/month (includes $5 usage; 6 replicas, 48 vCPU / 48 GB per service = 8 / 8 per replica; 5 GB volumes; 7-day logs; 2 custom domains). **Pro $20/month** (includes $20 usage; 42 replicas, 1,000 vCPU / 1 TB per service = **24 vCPU / 24 GB per replica**; volumes to 1 TB; 30-day logs; 20 custom domains; 100 services per project; 10 concurrent builds). Committed spend of $5,000/month raises a replica to 48 vCPU / 48 GB and 50 replicas. |
| Usage prices **[doc]** | CPU $0.00000772 per vCPU-second ($20 per vCPU-month); RAM $0.00000386 per GB-second ($10 per GB-month); volumes $0.15 per GB-month; **service egress $0.05 per GB**; buckets $0.015 per GB-month with **free egress and free S3 operations**. Billed on actual use per second, not on reservation; builds are free. |
| WebSockets **[doc]** | Supported over HTTP/1.1. "Exempt from the duration and inactivity limits": open indefinitely, even idle. |
| HTTP limits **[doc]** | About **11,000 requests per second per domain**; **10,000 concurrent connections per service**; 10,000 requests per connection; request up to 15 minutes while data flows, closed after 5 minutes of silence; HTTP/1.1 keep-alive idle 60 s; headers 32 KB; HTTP/1.1 and HTTP/2, TLS 1.2/1.3. Higher limits on request (team@railway.com). |
| UDP, HTTP/3, WebTransport | Not available: the edge speaks HTTP/1.1 and HTTP/2, plus a TCP proxy **[doc]**; inbound UDP is an open feature request **[community]**. Plan for WebSocket only. |
| Scaling **[doc]** | Vertical: a replica uses up to the plan limit automatically. Horizontal: **manual replica count, no autoscaler**; replicas can be placed per region and changed without a full redeploy. A public GraphQL API and CLI exist for scripted changes (Pro: 10,000 API requests per hour). |
| Routing **[doc]** | Traffic enters the nearest edge POP, goes to the nearest region with a replica, then is **distributed randomly** among that region's replicas. **Sticky sessions are not supported.** TCP proxy: same random distribution. |
| Regions **[doc]** | Four: US West (California), US East (Virginia), EU West (Amsterdam), Southeast Asia (Singapore). Anycast edge POPs in "dozens of cities". A service's region can change without downtime unless it has a volume. |
| Cold start | None for a running service. (App sleeping exists and must stay off for the sim.) |
| Private networking **[doc]** | Encrypted WireGuard mesh per environment, `SERVICE.railway.internal`, no configuration. **Buckets are reachable over the public endpoint only.** Databases are private by default; a public TCP proxy can be added and is billed as egress. |
| Volumes **[doc]** | One per service; **a service with a volume cannot have replicas**; redeploying it causes brief downtime; 3,000 read and 3,000 write IOPS at every size; 50 GB default on Pro, live resize to 1 TB; deleted volumes restorable for 48 h. No durability or replication statement is published. |
| Backups **[doc]** | Volume snapshots, manual or scheduled: daily kept 6 days, weekly kept 27 days, monthly kept 89 days; incremental copy-on-write, billed at the volume rate for unique data; restore mounts a new volume in the same project and environment and redeploys. Wiping a volume deletes its backups. |
| Postgres **[doc]** | A template: "a single node that Railway maintains", SSL image on the official Postgres image. Convertible in place to an HA cluster (Patroni, etcd, HAProxy); PgBouncer available; point-in-time recovery is a separate feature (its page was not reachable in this pass); PostGIS / Timescale / pgvector as marketplace templates. Changing the template makes it yours to operate. |
| Redis **[doc]** | A template: single node from the official image; convertible to HA (Sentinel, HAProxy). |
| Buckets **[doc]** | S3-compatible, on Tigris (endpoint `https://t3.storageapi.dev`). Put/Get/Head/Delete/List/Copy, multipart, **presigned URLs up to 90 days**. **Private only: no public buckets.** No versioning, no lifecycle rules, no automatic backups; a deleted bucket is restorable for 52 h. CORS is set with `put-bucket-cors` (documented for uploads). Region fixed at creation. |
| CDN **[doc]** | Beta, free on every plan, off by default, per service. Caches GET/HEAD without `Authorization`; static content types cached by default, other types only with `max-age`/`s-maxage`; default TTL 2 h; cache key = method, host, path, query; **responses over 512 MB are not stored**; a hit "doesn't incur network egress"; whole-service purge only; no hit-rate metrics; hits do not appear in request logs. Range support was broken until 2026-07-09 and is now stated as fully supported **[community, staff reply]**. |
| Edge rules, abuse **[doc]** | Per-service rules on client IP/CIDR, host, path, header with actions block, allow, challenge, redirect, override cache. No rate-limit action. Layer 4 DDoS is mitigated by the platform; layer 7 protection is partial, with a WAF "Under Attack Mode" referenced (its page was not reachable). Requests carry `X-Real-IP`. |
| Deploys **[doc]** | GitHub App autodeploy on push to a chosen branch; optional "Wait for CI" (all GitHub Actions workflows on the commit must pass; skipped after two hours); watch paths; Railpack or Dockerfile; healthcheck gates activation; old deployment gets SIGTERM, then SIGKILL after `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (**default 0**); `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` for overlap; rollback to a retained deployment. |
| Secrets **[doc]** | Service, shared and reference variables; **sealed variables** are injected into builds and deployments and can never be read back through UI, API, `railway run` or copied to other environments. |
| Logs, metrics **[doc]** | Dashboard, Log Explorer, `railway logs`; structured JSON lines; **500 log lines per second per replica**, excess dropped; retention 7 days Hobby, 30 days Pro; **no log drain**; metrics are summed over replicas (no per-replica view). |
| This account **[measured]** | CLI logged in; one workspace; one existing project (`haulpoint-tms`, unrelated, not to be touched). The CLI does not report the plan. |

### 3.2 Modal

| Topic | Fact |
|---|---|
| Plans **[doc]** | Starter $0 + usage, $30 free credits a month, **100 containers**, 10 concurrent GPUs, 5 cron jobs, 1-day logs, 1 TiB egress included. Team $250 + usage, $100 credits, 5,000 containers, 30-day logs, custom domains, static IP proxy, 10 TiB egress included. |
| Prices **[doc]** | CPU $0.0000131 per **physical core**-second (2 vCPU equivalent; $34 per core-month), memory $0.00000222 per GiB-second, minimum 0.125 core; billed on max(request, use). **Non-preemptible: 3x.** Region pinning: 1.15x (broad, e.g. `us`) to 1.75x (narrow, e.g. `us-west`). Sandboxes bill at the 3x rate. Egress $0.04 per GiB beyond the included amount. Volumes $0.09 per GiB-month, first 1 TiB free. |
| Preemption **[doc]** | **Every Function is preemptible by default**; preemption is "rare" and more likely the longer a container runs; the input is restarted. `nonpreemptible=True` (CPU only) costs 3x. Sandboxes are not preemptible. |
| Lifetime **[doc]** | Function timeout 1 s to **24 h** (default 300 s). Sandbox lifetime up to 24 h. `scaledown_window` 2 s to 20 minutes. |
| HTTP **[doc]** | Web functions: **150 s request limit**, then a 303 redirect chain. Default rate limit **200 requests per second per Function** (burst of 15 s worth), 2,000 per second per workspace, 429 beyond. Request body to 4 GiB. |
| WebSockets **[doc]** | Supported on `web_server`, `asgi_app`, `wsgi_app`; **each connection is one function call**; messages to 2 MiB; no `permessage-deflate`; no WebSocket over HTTP/2. Lifetime is bounded by the function timeout. |
| Tunnels **[doc]** | `modal.forward(port)` exposes a container port at a random public URL, TLS terminated, WebSocket capable, or raw TCP; the container connects to the nearest relay; no extra charge; Modal adds no proxy headers. UDP is not mentioned. |
| Routing, regions **[doc]** | "All inputs to Modal Functions are routed through our servers in Virginia" unless `routing_region` (us-east, us-west, eu-west, ap-south) is set at first deployment. Containers run in any cloud unless `region=` is set. |
| Scaling **[doc]** | Autoscaler with `min_containers`, `max_containers`, `buffer_containers`; scales to zero by default; hard limit 4,000 containers per Function; `@modal.concurrent(max_inputs=N)` for many inputs per container. |
| Cold start **[doc]** | "Containers boot in about one second", plus imports and initialisation; memory snapshots available. |
| Volumes **[doc]** | v1: **500,000 inode hard limit**, slow above 50,000 files. v2: no file-count limit, 262,144 files per directory, files under 1 TiB, hundreds of concurrent writers. Commit/reload semantics, last write wins, no snapshots or backups described. Not servable over HTTP by themselves. |
| Deploys **[doc]** | `modal deploy` from GitHub Actions with `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET`; `MODAL_ENVIRONMENT` selects an environment. |
| This account **[measured]** | Profile `sshh12`; one environment (`main`); four deployed apps and at least nineteen volumes that belong to other work. Everything for this game should live in its own Modal environment and app-name prefix so nothing existing is touched. |

### 3.3 Netlify

| Topic | Fact |
|---|---|
| Plans **[doc]** | Credit-based. Free: 300 credits a month, **hard limit**. Personal $9: 1,000 credits. Pro $20: 3,000 credits, unlimited members. |
| What credits buy **[doc]** | Bandwidth **20 credits per GB**; web requests 2 credits per 10,000; production deploy 15 credits (previews and branch deploys free); compute 10 credits per GB-hour. Auto-recharge (off by default, team owner only): Pro 1,500 credits for $10, i.e. $0.133 per GB, $1.33 per million requests, $0.10 per production deploy. |
| Out of credits **[doc]** | "All of your web projects are paused and visitors ... will find a `Site not available` page." |
| Deploy limits **[doc]** | No limit on files per deploy; **54,000 files per directory** fails the deploy; atomic deploys with de-duplicated uploads. |
| Functions **[doc]** | No open connections: "WebSockets: Server Yes, Functions No, Edge functions No". 1 GB default memory, up to 4 GB on Pro. Edge functions: 50 ms CPU per request, 512 MB, 40 s header timeout. |
| Netlify Server **[doc]** | Long-lived Node process with WebSockets and in-memory state, **Early Access**: free for now, GA price unannounced; **up to 3 instances** (1 on Free and Personal); 32/64/128 concurrent requests per instance by size and "a couple of hundred" WebSockets; connections closed at 30 minutes (2 h on Pro); an instance is **replaced after 8 h**; always scales to zero after 5 idle minutes; "meant for evaluation, experimentation, and low-volume production use". |
| Rate limiting **[doc]** | Code-based rules on functions, edge functions and redirects: 5 rules per project on Pro, per IP and domain, window up to 180 s, up to 10 s before enforcement. |
| Database **[doc]** | Managed Postgres with branching per deploy preview, on credit plans; limits and external reachability not stated on the overview page. |
| This account **[measured]** | Netlify CLI not installed; no token in `.env`. |

---

## 4. Where each workload goes

| Workload | Placement | Why, and what was rejected |
|---|---|---|
| (a) Authoritative simulation | **Railway**, Node services, WebSocket | Only platform with unlimited-duration WebSockets, cheap always-on CPU, big replicas and a database on a private network. Modal rejected as the base: 3x price without preemption, 24 h cap, one function call per socket, 200 requests/s default limit, us-east input routing. Netlify Server rejected: Early Access, 3 instances, a few hundred sockets each, 8 h replacement. |
| (b) Persistence | **Railway Postgres** on a volume, scheduled volume backups, plus logical dumps and world snapshots to a **Railway bucket** | Private networking to the sim; pay for use. Redis only when a gateway tier needs cross-process pub/sub. Modal Dict/Volume and Netlify Database are not transactional stores next to the sim. |
| (c) Static front end | **Netlify Pro** (shell only) or a **Railway static service** | Section 9, T1 against T2. Large binaries never go through Netlify. |
| (d) Planet data, sky, audio, textures | **Railway bucket**, packed, presigned; fallback Railway service + CDN; optional Hugging Face mirror | Section 5. |
| (e) Elastic compute | **Modal** Functions (preemptible) | Bots, bakes, replay audits, planners. Volume v2 or direct S3 writes for outputs (v1 breaks at 500,000 files). |
| (f) Lobby, identity, rate limits | **Railway**, in the gateway/API service beside Postgres | Session tokens signed with a sealed key; per-IP caps from `X-Real-IP`; edge rules for blocks. Netlify functions would need the database over a billed public proxy. |

---

## 5. Planet data delivery

### 5.1 Constraints that decide it

- **Egress price.** 15 TB in a day costs $0 from a Railway bucket, up to $750 through a Railway service,
  about $2,000 on Netlify, about $520 on Modal, about $1,190 on CloudFront pay-as-you-go.
- **Request count.** At 16 KB a file, 15 TB is about 940 million requests in a day: **10,900 per second on
  average**, at or above Railway's documented 11,000 per second per domain before any peak, $1,250 of Netlify
  request credits, $930 of CloudFront request fees, and far above any CloudFront flat-rate allowance below
  Premium. Request count has to fall by an order of magnitude on every platform.
- **Addressability.** Railway buckets are private; a browser reaches an object only through a presigned URL.
  Hugging Face recommends under 100,000 files per repository and enforces 10,000 entries per folder. Modal
  Volume v1 stops at 500,000 inodes. Netlify fails a deploy with a directory above 54,000 files (the current
  layout is safe on that one: at most 4,096 entries per directory).
- **Cross-origin isolation.** Responses need `Access-Control-Allow-Origin` and must expose `Content-Range`.
  A single `bytes=a-b` range header is a CORS-safelisted request header, so it should need no preflight
  (confirm in test 2 of section 12).

### 5.2 Verdict on packing

**Packing is required for production; the bake output and the dev server stay as plain files.**
`ARCHITECTURE.md` decision 4 ("no pack files: plain files on disk") was right for one machine and is the one
v1 decision hosting overturns. The seam already exists: tile bytes come from a `TileSource`. Add a deploy-time
packer and a ranged-HTTP tile source; the bake pipelines, the codec and the fs source do not change.

Properties the pack format needs, each tied to a platform fact:

| Property | Reason |
|---|---|
| Packs of about 64-256 MB (about 60-200 files in all) | Railway CDN does not store responses over 512 MB; Tigris copies a whole object to a region on first ranged read **[community]**; Hugging Face file-count limits; a short list of presigned URLs |
| All layers of one tile coordinate adjacent ("tile group"), groups in quadtree (Hilbert or Morton) order per level | One range returns height, albedo, water mask, night and land cover: five times fewer requests at once; neighbouring groups coalesce into one range, another factor of 2-10 |
| Index outside the packs (in or beside the manifest), offsets as `[pack, offset, length]` per tile group | No directory round trips; the manifest stays the single promise of what exists |
| Content-addressed pack names (hash in the name), never rewritten | `immutable` caching everywhere, mirrors are interchangeable, a new bake never invalidates a running client |
| Height layers in their own packs | The simulation server downloads 9.65 GB, not 13.9 GB |
| Client cache keyed by content hash in OPFS or Cache Storage | Presigned and Hugging Face URLs change, so the browser HTTP cache alone would re-download; also keeps return visits off the network |
| Ordered mirror list per pack with failover on 429, 5xx and timeout | The primary path is unproven at HN scale |

### 5.3 Options inside the three

| Option | Cost: quiet / busy / HN day | Facts | Verdict |
|---|---|---|---|
| **A. Railway bucket, presigned pack URLs** | $0.24 a month storage; **$0 egress** at every level | Bytes never pass through a service. URLs valid up to 90 days: sign with a quantised date so every client gets the same URL for a week. Tigris caches near readers. CORS for GET must be set with `put-bucket-cors` (documented for uploads; one forum report of a failing preflight). **Risk [community, 2026-05-27, unanswered]:** signed GETs slowed 3-7x and 30 % failed at 100 concurrent fetches while Cloudflare R2 stayed flat. | **Primary**, after a throughput test |
| **B. Railway service with CDN in front of the bucket or a volume** | Hits free, misses $0.05 per GB: about $20 / $68 / $23 at 70 %, 95 %, 97 % byte hit rates; **worst case $68 / $1,350 / $750** | Stable URLs, so the browser cache works unaided. CDN is beta, has no hit-rate metric and no published retention; subject to 11,000 requests/s per domain and 10,000 connections per service; Range supported since July 2026. A volume origin (14 GB, $2 a month) cannot have replicas. | **Fallback mirror** |
| C. Netlify | $180 / $3,600 / $2,000 bandwidth, plus requests | 862,000-file deploys are impractical; packs would deploy, but the price stands | Rejected |
| D. Modal web endpoint | about $10 / $970 / $520 egress, plus compute | 200 requests/s default limit per Function, us-east routing | Rejected |

Sky data (129 MB) and `public/assets` (37 MB) take the same path as tiles. That keeps Netlify bandwidth to the
shell.

### 5.4 Hugging Face Hub as a CDN

- **[measured]** `https://huggingface.co/datasets/<owner>/<repo>/resolve/main/<file>` answers 302 with
  `Cache-Control: no-store` to a signed CDN URL (CloudFront in front of Xet storage) valid for **3,600 s**.
  The resolve response echoes the caller's origin in `Access-Control-Allow-Origin`; the CDN response sends
  `access-control-allow-origin: *`, `accept-ranges: bytes`, and returns 206 with `Content-Range` for a range.
  A browser can therefore resolve a pack once an hour and range-read the CDN URL directly.
- **[doc]** Rate limit for anonymous callers: **3,000 resolver requests per 5 minutes per IP address**
  (the response header confirmed `q=3000;w=300`). Per-file tiles would trip it for a single player in a busy
  minute; packs with cached signed URLs use about a hundred an hour. Players behind one NAT share the limit.
- **[doc]** Dataset repositories: under 100,000 files recommended, 10,000 entries per folder enforced, so packs
  are mandatory. Free public storage is "best-effort"; beyond "the first few gigabytes" content must offer
  "genuine value to other users"; large datasets need a dataset card and must be shared "to enable community
  reuse". Storage Buckets include egress only up to **8 times the stored volume** (about 110 GB a month for
  14 GB), which rules them out.
- **Verdict.** Publish the packs as a public dataset and list it as a **secondary mirror**. It is free, it
  works from a browser, and baked Earth and Moon pyramids are a real dataset. It is not a primary: no service
  level, a policy that was not written for game delivery, and limits that can change. The token in `.env` is
  for uploads from build tools only; browsers fetch anonymously. Check licences before publishing anywhere:
  the regional Earth albedo comes from Sentinel-2 cloudless, which `ARCHITECTURE.md` lists as CC BY-NC-SA.

### 5.5 Simulation servers and terrain

A service with a volume cannot have replicas, so simulation shards cannot share a volume. Each shard reads the
height packs from the bucket (free egress, free operations) by range into ephemeral disk (100 GB per replica)
behind an LRU, or copies the 9.65 GB at boot. Uploads from a service to a bucket count as service egress;
uploads from the development machine or Modal do not touch Railway billing.

### 5.6 Is an outside CDN or object store worth asking for

Not now. Ask only if the option A throughput test fails and option B's hit rate is poor. The case then:

| Outside option | HN day, 15 TB | Needs from the user | Note |
|---|---|---|---|
| Cloudflare R2 behind a Cloudflare domain **[doc]** | About $0-35: storage $0.015 per GB-month, **egress free**, reads $0.36 per million with 10 million free | A Cloudflare account and a domain on it | Cheapest and the benchmark Railway's bucket lost to in the forum report |
| AWS S3 + CloudFront flat-rate **[doc]** | Pro $15 a month (50 TB, **10 M requests**), Business $200 (50 TB, 125 M requests), Premium $1,000 (500 M requests); "no overage charges" | The AWS account the user offered | The request allowance binds: per-file tiles need Premium; coalesced packs fit Business, and Pro at quiet load |
| AWS S3 + CloudFront pay-as-you-go **[doc]** | About $1,190 transfer (first 1 TB free, then $0.085 and $0.080 per GB) + $0.01 per 10,000 requests | Same | Worse than flat-rate |

Against the in-three worst case of $750 for the day (option B with every request a miss), an outside CDN saves
at most a few hundred dollars per spike. It becomes worth it only at sustained busy load with a poor hit rate
(option B worst case $1,350 a month against $15-200).

---

## 6. Persistence

- **Authoritative store: Postgres on Railway**, reached over the private network. Idle cost is a few dollars
  (billed on use); 3,000 IOPS on the volume is ample for write-behind journals of a few hundred rows a second.
- **What is durable and what is not.** Railway publishes no replication or durability figure for volumes, and
  volume backups live with the volume ("wiping a volume deletes all its backups"; restore only into the same
  project and environment). Treat the volume as one copy. Second copy: scheduled `pg_dump` and periodic world
  snapshots to a Railway bucket (a different storage system, Tigris). Third copy for the paranoid: the same
  object pushed to a private Hugging Face dataset or a Modal volume by a nightly Modal job.
- **Buckets have no versioning, no lifecycle rules and no backups.** The application must name snapshots by
  time and delete old ones itself.
- **Backup schedule available today:** daily (6 days), weekly (27 days), monthly (89 days), incremental,
  billed only for changed blocks. Point-in-time recovery and an HA cluster exist as options; neither is needed
  below the busy level.
- **Every deploy of a simulation service is a restart.** The default drain is 0 s: SIGTERM, then SIGKILL. Set
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` long enough to flush state, keep the simulation in its own service with
  watch paths so front-end and API pushes never restart it, and treat "restart recovery" as the normal deploy
  path. A service with a volume also has brief downtime on redeploy, so Postgres is redeployed rarely.
- **Redis** is not needed while one process family shares memory or Postgres `LISTEN/NOTIFY` suffices. Add the
  template when stateless gateways must fan out across shard services.

---

## 7. Compute split: what each choice costs to host

Per connected player, with the assumptions of section 2:

| Split | Server CPU per player | 20 | 500 | 5,000 (HN) |
|---|---|---|---|---|
| S1. Server integrates every active vessel at 120 Hz; clients predict | 0.0245 vCPU (0.0425 on an HN day) | 0.75 vCPU | 12.5 vCPU | **215 vCPU** = nine 24-vCPU replicas |
| S2. Clients integrate vessels that are alone; the server integrates interaction bubbles and audits a sample by deterministic replay (25 % of integration stays on the server) | 0.0076 vCPU (0.0121) | 0.4 vCPU | 4 vCPU | **61 vCPU** = three replicas |
| S2 with audits moved to Modal batch jobs and 10 % of vessels in bubbles | 0.0043 vCPU (0.0061) | 0.3 vCPU | 2.4 vCPU | **30 vCPU** = two replicas |

Hosting consequences:

- **Money does not separate these.** S1 on the HN day is about $160 of Railway compute; S2 about $47. At 500
  sustained players S1 costs about $190 a month more than S2.
- **Topology does.** One Node thread carries about 33 integrated vessels. S1 needs about 215 threads on nine
  machines for the spike; none of the splits fits the spike in one 24-vCPU replica, let alone one process.
  Multi-process, multi-machine simulation is a baseline requirement, not a later optimisation.
- **Determinism is the lever.** `src/sim` is bit-reproducible from scenario plus input sequence, so the server
  can accept a client-integrated segment only after replaying it, exactly. Replays are batch work with no
  latency requirement: Modal preemptible CPU at $0.0000131 per core-second, scaled to zero when idle.
- **Egress is identical in every split** (the server still fans out state), so the bitrate budget matters
  more to the bill than the split does.
- **Work that belongs on the server regardless:** rails propagation, SOI transitions, expiry and conjunction
  screening for logged-out ships (cheap, periodic); anything that decides an outcome for two players.
- **Work that should stay on the client:** rendering, own-ship prediction, own-ship trajectory patches and
  maneuver-node editing (pure functions of state the client already has).
- **Work worth offloading to Modal on demand:** transfer-window and intercept searches over many targets,
  replay audits, bakes, bot fleets. About 1 s cold start and us-east routing are acceptable for a planning
  tool, not for anything in the control loop.

---

## 8. Network facts that shape the protocol

- **One region holds the authoritative universe.** US East (Virginia) is the balanced choice for a US and
  European audience; Southeast Asia and Australia will see roughly a quarter second of round trip. A
  WebSocket enters at the nearest edge POP and rides Railway's backbone to the region.
- **WebSocket over TCP only.** No UDP, no WebTransport on any of the three. Design for head-of-line blocking:
  latest-state snapshots, drop superseded data before send, small frames, a client interpolation buffer.
- **10,000 concurrent connections per service.** 5,000 players use half. 50,000 visitors looking at a live
  menu must not each hold a socket: serve the menu's live view from a CDN-cacheable snapshot (non-HTML
  responses are cached only with an explicit `max-age`) and open the socket on "Launch".
- **No sticky routing and random distribution among replicas.** A socket stays on the replica it reached, so
  only the connect matters. Addressing a particular shard needs either one Railway *service per shard* with
  its own domain (the lobby API returns the URL; Pro allows 100 services), or stateless gateway
  replicas that forward to shards over the private network. Replicas of one service are not individually
  addressable from outside.
- **No autoscaler.** Replica counts change by hand or by a script against the Railway API. Pre-scale before an
  announced launch; usage billing means idle headroom costs only its memory.
- **Egress price sets a bitrate budget:** $0.13 per player-month per 1 kB/s.
- **Logs are capped at 500 lines per second per replica and metrics are summed across replicas.** Shards must
  publish their own tick time, integrated-vessel count, connection count and bytes per second.

---

## 9. Topologies and cost

Common to all three: GitHub repository `sshh12/fable-space-program` with autodeploy; anonymous device
identity; tiles on the Railway bucket (option A, mirror B, optional Hugging Face mirror); Modal for bots and
bakes. Costs use section 2's assumptions and list prices. "Quiet" and "busy" hold that concurrency for a whole
month; "HN day" is the extra cost of one day at 5,000 concurrent with 50,000 visitors.

### T1. Railway core, Netlify shell, Modal burst (recommended)

```
browser ── HTTPS ──> Netlify CDN            shell: index.html, JS, CSS, COOP/COEP headers
        ── HTTPS ──> Railway `api`          session token, lobby list, shard address, presigned pack list
        ── WSS ────> Railway `sim-*`        authoritative shards (one service each), worker threads
        ── Range ──> Railway bucket (Tigris) tile, sky and asset packs   [mirror: `edge` service + CDN]
Railway private network:  api, sim-* ── Postgres (volume, backups) ; snapshots and dumps ── bucket
Modal (own environment):  bot fleets ──WSS──> sim-* ; bakes ──S3──> bucket ; replay audits ; planners
```

| Line | Quiet (20) | Busy (500) | HN day (+) |
|---|---|---|---|
| Simulation CPU, S1 / S2 | $15 / $8 | $250 / $80 | $143 / $41 |
| Simulation RAM | $15 | $60 / $40 | $18 / $7 |
| API and gateway | $5 | $30 | $10 |
| Postgres, volume, backups | $8 | $46 | $5 |
| WebSocket egress at 3 kB/s | $8 | $197 | $65 |
| Bucket storage (16 GB) | $0.24 | $0.24 | - |
| Tile egress, option A | $0 | $0 | $0 |
| `edge` mirror service, kept warm | $3 | $15 | $2 |
| Netlify Pro, shell only (3 MB per new visitor) | $20 | about $80 | $10-30 |
| Modal | $0 (inside $30 credits) | $0-30 | rehearsals, below |
| **Total, S1 / S2** | **about $75 / $70** | **about $680-710 / $490-520** | **about $250-275 / $140-160** |

- Railway's $20 Pro fee includes $20 of usage, so it is not added on top.
- If the tile path falls back to option B: quiet +$20, busy +$68, HN day +$23 at the hit rates of 5.3;
  worst case +$68, +$1,350, +$750.
- Pre-launch rehearsals: a one-hour 5,000-bot run is about $13 on Modal (200 cores, 400 GiB) plus about $9 on
  Railway. Five rehearsals and the smaller runs before them: about $100-150, inside the R&D allowance. Starter
  allows 100 containers, so about 50 bots per container.
- **Bottleneck:** single-thread integration (about 33 vessels per vCPU) and the 24-vCPU replica; then 10,000
  connections per service; then egress cost. The unproven element is bucket throughput.

### T2. Railway only at run time (no Netlify)

The shell is one more Railway service (static files, CDN enabled). Everything else as T1.

| | Quiet | Busy | HN day (+) |
|---|---|---|---|
| Total, S1 / S2 | about $55 / $50 | about $600-630 / $410-440 | about $250 / $140 |

- Even with no CDN hits the shell is cheap on Railway: 50,000 visitors x 3 MB = 150 GB = $7.50.
- Gains: one fewer account and token, no credit exhaustion mode, one deploy system.
- Loses: deploy previews and instant rollback of the shell, a mature CDN for first paint (Railway's is beta).
- **Bottleneck:** as T1. Choose T2 if the user prefers not to set up Netlify; switching later is a DNS change.

### T3. Simulation shards on Modal, control plane on Railway

Shards run as non-preemptible Modal containers reached through tunnels; API and Postgres stay on Railway.

| | Quiet | Busy | HN day (+) |
|---|---|---|---|
| Simulation on Modal (3x rate, one physical core taken as 1.3 vCPU) | about $88 | about $1,100 | about $590 |
| Total, S1 | about $125 | about $1,370 | about $650 |

- Gains: shards start in about a second and scale to zero; 1 TiB of egress included, then $0.04 per GiB.
- Costs: about 4-5x the CPU price; a 24 h container limit forces a daily hand-over; a random tunnel URL per
  container must be brokered; state must cross the public internet to Postgres (billed TCP proxy) or live in
  Modal volumes with last-write-wins semantics; preemptible containers would be a third of the price but can
  vanish with their sockets.
- **Bottleneck:** price and the 24 h limit. Use this only as **spike overflow** for T1 if Railway replicas
  cannot be added fast enough; do not build on it first.

---

## 10. Scaling path (in the order to take it)

1. **Vertical.** One simulation service up to 24 vCPU / 24 GB with a worker thread per interaction island.
   Holds roughly 550-950 connected players under S1 at the assumed costs, more under S2 (to be measured).
2. **Split connection handling from integration.** Stateless gateway replicas (random distribution is fine)
   do fan-out, interest filtering and compression; shards integrate. Lifts the 10,000-connection ceiling to
   10,000 per gateway service.
3. **Shard by region of space.** One service per shard: the surroundings of each launch pad (where an HN
   crowd is), low orbit, each remote sphere of influence, and a cheap shard for everything on rails. One
   universe clock; hand-over at bubble boundaries. This is what keeps one mega-lobby coherent across machines.
4. **Move the compute split** from S1 toward S2 for vessels that are alone, with audits on Modal.
5. **Shard by lobby.** When pads or the map saturate socially, a second lobby is a second copy of the stack
   with no cross-talk. The lobby is already the unit in the brief.
6. **Read paths.** Cache public read-only state at the CDN for a few seconds; add a Postgres replica or the HA
   cluster only when API reads compete with journal writes.
7. **Edge caching.** Already total for immutable packs; the lever left is the client's persistent cache.
8. **Limits to request from Railway before a launch:** more than 10,000 connections per service and more than
   11,000 requests per second per domain ("higher limits on request").

---

## 11. What the user must provide or approve

| Item | Why |
|---|---|
| **Railway Pro** on the workspace ($20 a month, includes $20 usage) | 24 vCPU / 24 GB replicas, 42 replicas, volumes over 5 GB, 30-day logs. The CLI could not confirm the current plan. |
| Approval to create a new Railway project for this game and to install the Railway GitHub App on `sshh12/fable-space-program` | Autodeploy; the existing `haulpoint-tms` project stays untouched. |
| **Netlify** (T1 only): a Pro team ($20 a month) with **auto-recharge switched on** by the owner, and either `NETLIFY_AUTH_TOKEN` + site id for GitHub Actions or the Netlify GitHub App on the repository. `npm i -g netlify-cli` locally. | None of this exists on the machine. Without auto-recharge the site pauses when credits run out; the Free plan cannot survive a spike (300 credits = 15 GB). |
| **Modal**: approval to create a dedicated environment and prefixed apps; a token pair for GitHub Actions if CI deploys | Keeps the four existing apps and the existing volumes out of reach. Starter is enough. |
| **Budget**: about $100 a month standing; about $500-710 a month if 500 players are sustained; a spike reserve of about $300 (plus $750 if the free tile path fails on the day); about $150 one-time for rehearsals | The $500 per provider allowance is R&D, not hosting. |
| Go or no-go on publishing the tile packs as a public Hugging Face dataset | Free mirror; needs a dataset card and a licence check (Sentinel-2 cloudless is CC BY-NC-SA). |
| Optional custom domain and DNS access | Not required; provider domains work. |
| Outside CDN or AWS | **Not requested now.** Trigger and numbers in 5.6. |

Deploy secrets live in GitHub Actions (Railway project token, Netlify token and site id, Modal token pair).
Run-time secrets (token signing key, bucket credentials, database URL) are Railway sealed or reference
variables. The client holds no provider credential: it receives presigned pack URLs and a session token.

---

## 12. To verify by test before the design depends on it

| # | Unknown | Test |
|---|---|---|
| 1 | Railway bucket throughput at HN concurrency (forum report of collapse at 100 concurrent signed GETs) | Modal fleet of 2,000-5,000 workers replaying real tile ranges for 15 minutes; pass = flat p95 and no errors |
| 2 | CORS for ranged GET on bucket URLs under COEP, and that a quantised signing date yields one URL for all clients | One page, one pack, Chrome |
| 3 | Railway CDN (beta): ranged reads on 64-256 MB objects, retention, hit rate with no metrics | Same fleet against the `edge` mirror; measure billed egress |
| 4 | CPU per integrated vessel and per connection on a Railway vCPU; players per shard | Bot fleet flying real ascents; this replaces every number in sections 7 and 9 |
| 5 | Whether replicas are individually addressable on the private network | Decides gateway-to-shard routing against one service per shard |
| 6 | Railway's real behaviour at 10,000 connections and at reconnect storms after a deploy | Bot fleet connect/disconnect waves |
| 7 | Postgres point-in-time recovery and WAF terms | Their documentation pages were unreachable in this pass |
| 8 | Modal images running Node 24 inside a Function, and S3-compatible mounts against the Tigris endpoint | Small spike in the dedicated environment |
| 9 | Netlify function time limits | Not retrieved; nothing is placed there |

---

## 13. Sources (fetched 2026-11-10)

Railway: `railway.com/pricing`; `docs.railway.com/reference/pricing/plans`;
`docs.railway.com/reference/pricing/committed-spend`;
`docs.railway.com/networking/public-networking/specs-and-limits`; `docs.railway.com/reference/scaling`;
`docs.railway.com/reference/regions`; `docs.railway.com/networking/edge-networking`;
`docs.railway.com/networking/edge-rules`; `docs.railway.com/networking/cdn`;
`docs.railway.com/reference/private-networking`; `docs.railway.com/reference/tcp-proxy`;
`docs.railway.com/reference/volumes`; `docs.railway.com/reference/backups`;
`docs.railway.com/guides/postgresql`; `docs.railway.com/guides/redis`;
`docs.railway.com/guides/storage-buckets`; `docs.railway.com/storage-buckets/uploading-serving`;
`docs.railway.com/reference/deployments`; `docs.railway.com/guides/github-autodeploys`;
`docs.railway.com/guides/variables`; `docs.railway.com/guides/logs`; `docs.railway.com/reference/public-api`.
Forum threads on `station.railway.com`: CDN and 206 responses (2026-06-28 to 2026-07-09); signed URL fetches
under high concurrency (2026-05-27); bucket egress (2026-09-19); inbound UDP requests.

Modal: `modal.com/pricing`; `modal.com/docs/guide/` pages `webhooks`, `webhook-timeouts`, `timeouts`,
`preemption`, `scale`, `cold-start`, `region-selection`, `resources`, `tunnels`, `sandbox`, `volumes`,
`continuous-deployment`, `dicts-and-queues`.

Netlify: `www.netlify.com/pricing/`; `docs.netlify.com` pages on how credits work, deploy overview, functions
overview and usage, edge function limits, Netlify Server and its limits, rate limiting, repository
permissions, Netlify Database.

Hugging Face: `huggingface.co/docs/hub/storage-limits`; `huggingface.co/docs/hub/rate-limits`;
`huggingface.co/docs/hub/storage-buckets`; `huggingface.co/storage`; header probes of a public dataset file.

Outside the three: `developers.cloudflare.com/r2/pricing/`; `aws.amazon.com/cloudfront/pricing/` and its
pay-as-you-go page; `www.tigrisdata.com/docs/objects/caching/`; a Fly.io community thread on Tigris range
caching (2024-09).

Local: `railway whoami`, `railway list`, `modal app list`, `modal volume list`, `modal environment list`,
`modal profile current`; `docs/handoff/bake-earth.md`, `docs/handoff/bake-moon-sky.md`,
`docs/ARCHITECTURE.md`, `tools/server/dataPlugin.ts`, `docs/research/v2/user-decisions.md`.
