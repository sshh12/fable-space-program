# Open questions for the user (v2)

Decisions that are the user's: money, accounts and tokens, and product choices with real trade-offs. The
user's decisions are recorded in `docs/research/v2/user-decisions.md`; this file says what each one means
for the work, which questions are still open, and what the work proceeds on until they are answered.

The lead records each answer here (date, answer) under the question; work packages read this file to know
what is approved.

**Nothing here blocks the work.** The hosting budget, the Railway project and the Modal environment are
approved, so the game is deployed in the build waves. Every remaining question has a default that the
work proceeds on.

**What may be spent without asking again.**

- Hosting: the always-on deployment at stage 0 of ARCHITECTURE 16.2 on the Railway Hobby plan, inside
  about $50 a month.
- R&D, inside the existing $500 per provider allowance: Modal probes and throughput tests, bot fleets,
  bake jobs, audio generation, and short-lived rehearsal environments that fit the Hobby plan (a few
  dollars each).
- **Not without the lead telling the user first**: the Pro plan, any step that raises the standing spend,
  and any rehearsal that needs more than the Hobby plan allows.

Status of every figure: list prices fetched 2026-11-10 and 2026-11-11 (`docs/research/v2/hosting.md`,
`hosting-small.md`); capacity and cost of the game are **estimates**, each given with a low and a high
value; the memory figures of the small stage were measured on the development machine. Nothing of the
game has been measured on Railway. One account fact has: what the workspace already pays for its other
project (`railway usage`, read 2026-11-10; Q1 and Q2). The first measurements replace the estimates
(`docs/capacity/`).

---

## Summary

| # | Item | Status | The work proceeds on |
|---|---|---|---|
| Q1 | Hosting budget | **Answered 2026-11-11** | About $50 a month or less at about 5 players on the Hobby plan; about $30 or less idle; more only on measured need, announced first |
| Q2 | Railway project and plan | Project: **answered 2026-11-11**. Plan: **open, and worth a look now**: the workspace's other project already uses the Hobby plan's included $5, so Pro from the first day would cost $0-8 a month more, not $15 | Hobby, with our own hourly dumps; the lead says so when the workspace's usage reaches $20 a month, which may be within weeks |
| Q3 | Shell host | Default stands (2026-11-11) | Railway only |
| Q4 | Modal environment | **Answered 2026-11-11** | Environment `fsp`; existing apps untouched |
| Q5 | Deploy access | **Open** (a click by the user; nothing is blocked) | Rollouts from the development machine's logged-in CLIs |
| Q6 | Automatic scale ceiling; sustained 5,000 | Default stands; it applies only from stage 3 | 6 shards and $60 a day, confirmed with the user before stage 3 is provisioned |
| Q7-Q16 | Product choices | Defaults stand (2026-11-11) | The defaults listed below |
| Q17 | Bodies the fleet cannot reach | Asked only if the reachability table says so | - |
| Q19 | The larger load rehearsals | **Open**: asked by the lead when the stage-0 numbers exist (a fixed checkpoint in wave 6) | Stage-0 measurements only; larger sizes reported as estimates |
| - | Alert destination (formerly Q18) | **Withdrawn 2026-11-11**: no alerts for now | No alert routing is built; metrics and logs stay |

---

## Answered

### Q1. Hosting budget (answered 2026-11-11)

Verbatim: "we need to be able to run with like 5 players at much less, like $50/mo and then scale from
there. I have railway hobby for now but we can upgrade and scale as we need to but shouldn't need for
small scale." And later: "it doesn't have to be scale to complete zero, could be down to like $30/mo ish
if zero is very complex or hard for the hosted part."

What the design does with it (ARCHITECTURE 16.2 and 30):

| The user's figure | The design's estimate | How it is checked |
|---|---|---|
| About $50 a month or less at about 5 concurrent players, everything included | The game **adds $10-25 a month** to the Railway bill with 5 players held all month on stage 0 (one `game` process, `shell`, Postgres, an hourly dump job, two buckets; Modal inside its free credit). Counted with the whole $5 plan fee: $15-30 | Projected from measured usage on the deployed stage by `deploy-loadtest` and again by `final-gate`, by one formula (the game's usage plus the $5 fee against the ceiling): an acceptance criterion |
| About $30 a month or less when nobody plays | The game **adds $5-15 a month**; with the plan fee, $10-20. Nothing sleeps. An empty universe runs no tick loop; one simulation thread and the launch site's terrain stay loaded ($1-2.50 of the figure), so neither the first visitor nor the first launch after a quiet spell waits for anything | The same measurement, 12 hours with nobody connected, and again after 72 hours of uptime |
| Scale from there by configuration and deploys | A ladder of four stages on one codebase; each move has a measured trigger and at most one announced freeze of under 40 s plus the resume window; committed state is never lost; players in flight find the new servers by themselves, without a reload | The moves are tested on the local stack in both directions and timed in a drill |

**What the Railway account already pays (measured 2026-11-10).** The Hobby plan's fee includes $5 of
usage for the whole workspace, and `haulpoint-tms` already uses more than that: $4.18 after 8 days of
the current billing period, $7.40 estimated for it, $10.23 in the period before. So the earlier
headline of "$5-10 idle, the plan fee included" was wrong for this account: every dollar the game uses
is billed on top. The corrected figures are the ones in the table. The whole workspace, both projects,
would then be about $13-25 a month idle and $17-35 at 5 players: still under both of the user's figures.

What the small stage does not do, so that it is not a surprise: **a front-page day that arrives
unannounced is not absorbed automatically**, and with no alerts nobody is told. The first 20 players play
normally (the cap that keeps the conservative projection for the game near $50 a month); everyone else
gets the title, the live Earth and a place in the queue, with a view of the flights for the first hour
or so. Such a day costs about $3-5. Moving up to the launch topology takes about an hour of a human's
time once somebody looks, and needs the Pro plan. An announced launch is moved up the day before.

**The most a month can cost** with no alert and no hard limit: about $140 for the game. About $100 of
that needs every service pegged at its resource limit for the whole month, which takes a runaway bug.
The other $40 is bytes: every way of pulling data from the game without being an admitted player (the
page itself, the tile fallback, the public status documents) has a daily allowance, after which it is
refused or sent to free storage. A scraper or a broken client can therefore add about $25 to a month,
not hundreds. A hard limit in Railway is not used because it is per workspace: it would stop
`haulpoint-tms` too.

The lead tells the user before the plan is upgraded or the standing spend rises.

### Q2 (part). The Railway project (answered 2026-11-11)

Permission is granted to create the project `fable-space-program` and its services, with deploy pipelines
from the GitHub repository. The existing `haulpoint-tms` project is never touched. Credentials stay out
of GitHub and the client.

### Q4. Modal (answered 2026-11-11)

Permission is granted to create a dedicated environment `fsp` with apps prefixed `fsp-` (bots, audits, an
off-site copy of the database dump, bakes, probes), and for the R&D spend of load-test bots. The four
existing apps and the existing volumes in `main` are never touched. The Starter plan allows 100
containers for the whole workspace, so the bot fleet runs 100 or more bots per 4-core container and the
existing apps keep their headroom.

### Local runs, scale to zero, alerts (answered 2026-11-11)

- **The whole game runs locally from one command with no cloud resource** (`npm run stack`,
  ARCHITECTURE 16.4): every server role, a real Postgres, tile delivery and several browser clients. By
  default it uses plain Node processes and an embedded Postgres 18, because that needs no daemon and
  about 160 MB where the Docker VM needs 1-3 GB. Docker Desktop is used, as the user allowed, only for the
  suites that need the pinned Linux image: restart, recovery and replay, and the image smoke test. Only
  one stack runs at a time: the command holds a machine-wide slot for as long as the stack is up, so two
  agents cannot start two stacks, or a stack beside the Docker VM, on the machine that once crashed.
- **Scale to zero** is used only where it is simple and robust: Modal, the dump job, and rehearsal
  environments that exist only while a measurement runs. The production server does not sleep, and it
  keeps one simulation thread and the launch site's terrain loaded while empty, because the user said
  about $30 idle is acceptable where zero would be fragile: the idle floor is the $5-15 above, and the
  first launch after a quiet evening is as quick as any other.
- **No alerts for now.** No alert routing is built and no destination is asked for. The numbers an alert
  would watch are on the operator page and in the capacity reports. Alerting is a later addition
  (ARCHITECTURE 32).

### Defaults the user let stand (2026-11-11)

"The other defaults in OPEN_QUESTIONS_V2.md stand." Each is a rules field or a data choice and can still
be changed later.

| # | Choice | In force |
|---|---|---|
| Q3 | Where the static shell is served | The `shell` service on Railway with Railway's CDN (about $0.7-1.2 a month at stage 0). Netlify stays an option for the shell only; it would need a Pro team with auto-recharge, a token, a site id and the CLI, and no Netlify configuration is shipped untested |
| Q7 | How far ahead a stranger may take someone's parked ship or station (`advanceLimit`) | 30 days for ships, 6 years for station modules; the owner can change it per craft. This is the number most likely to change after play-testing (result below) |
| Q8 | Second launch site | Madrakah, on the Arabian Sea coast of Oman near 19.0 N 57.8 E; fallback to all 32 pads inside the Ka Lae region if no acceptable ground is found there or the 30 m data cannot meet the v1 standard at pad level (the bake's hand-off and the ground checkpoints decide; ARCHITECTURE 31.3) |
| Q9 | Free-text chat | Not built; quick-comms (fixed phrases) only. The design for chat is kept as a forward seam |
| Q10 | Tile packs as a public Hugging Face dataset | No. Revisit only if the bucket throughput test fails |
| Q11 | Earth imagery licence | Keep Sentinel-2 cloudless (CC BY-NC-SA 4.0), credited on the Credits screen; swapping the regional imagery source is a precondition of any monetisation |
| Q12 | Desktop browsers other than Chrome and Edge | Allowed with a "not tested on this browser" banner when they pass every gate check; mobile and tablets are always blocked |
| Q13 | Server region | US East |
| Q14 | Player-facing rule values and the launch complex | A ship is kept 14 days after its owner's last session; 10 ship slots; a station lives as long as its most recently active owner and is removed whole 48 h after the last one lapses; debris 2 h, at most 24 pieces per account; an empty account 90 days; warp at most 250 years ahead; 300 s on a pad with one 120 s extension; **32 pads (16 per site)** and future launch slots up to **14 days ahead**. A sustained launch-heavy 5,000 would need 200-400 pads and is not offered by the first release |
| Q15 | First person on craft without a cabin | A sensor-camera view on the five vehicles without a cabin; the Egret reuses the Kestrel interior. Real cabins for the Albatross habitat or the Atoll core would be an additional package |
| Q16 | Offline practice, telemetry, domain | Practice (offline) is offered from the hub and when the server is unreachable; the client sends a CPU score and nothing else, no analytics; provider domains until the user supplies a domain and DNS access (the Hobby plan's two custom domains cover the shell and the game) |

**Q7 play-test (owner: the lead, between waves 5 and 6).** Two browsers on the local stack, the defaults
of U6, U8 and U9 (ready-check 15 s, idle 120 s, the jump and advance offers), the stories of ARCHITECTURE
28.5. The result, with any changed rule value and the measured share of the lobby that is mutually solid,
is written here:

> Result: (not yet run)

---

## Open

### Q2. When to move to the Pro plan, and whether to have platform backups from the first day

The Hobby plan has **no volume backups and no point-in-time recovery**. On it, the copies of the database
are our own: the volume, an hourly dump to a Railway bucket (a different storage system), and a nightly
copy of the newest dump off Railway on Modal. A crash or a deploy loses nothing. If the database volume
itself were lost, up to about one hour of ships and accounts would go with it.

Both plans bill the larger of the plan fee and the usage, **for the whole workspace**, and the workspace
already holds `haulpoint-tms` at $7-10 a month (measured). The table is therefore the bill of the
workspace, both projects together, at 0 to 5 players on the game:

| Option | The workspace's monthly bill, nobody playing | With 5 players all month | If the database volume is lost | Also brings |
|---|---|---|---|---|
| **A. Hobby now** (default) | $13-25 | $17-35 | Up to about 1 hour lost | - |
| B. Pro from the first day | $20-25 | $20-35 | Minutes (point-in-time recovery), plus daily, weekly and monthly backups | Deploys of one image by digest, 30-day logs, larger volumes and replicas. The upgrade covers the whole workspace, `haulpoint-tms` included |

**So Pro from the first day costs $0-8 a month more than Hobby, not the $15 an earlier version of this
file said**, and nothing more once the workspace's usage passes $20. That happens when the game alone
uses about $10-13 a month: with nobody playing on the high estimate, at about 5 to 9 concurrent players
on the low one. The Hobby stage may therefore last only weeks.

**Default: A**, because the user said "I have railway hobby for now" and "shouldn't need for small
scale". The lead tells the user when the workspace's projected usage reaches $20 a month (read from
`railway usage`, both projects; the game's own metrics cannot see the other project), or when the
database passes 4 GB of the Hobby plan's 5 GB. The upgrade itself is the user's click; the switch-over
afterwards is scripted and freezes the universe for seconds at most. Going back to Hobby later stays
possible until the database volume has been grown past 5 GB.

**Worth a decision now:** if an hour of possible loss on a volume failure matters more than up to $8 a
month, say "Pro from the start" and the first deployment is made on it.

### Q5. Deploy access

- **Railway's GitHub App on the private repository** (one authorisation by the user in GitHub), so that
  Railway can build `game` from the `release` branch and redeploy the shell on a front-end push.
  **Default until then:** rollouts are run from the development machine's logged-in CLI, which uploads a
  clean export of the release tag; Railway builds the same Dockerfile from it. Nothing is blocked.
- **A registry credential** (a GitHub token with `read:packages`), only when the deployment moves to the
  Pro plan and deploys the CI image by digest. Asked then.
- **GitHub Actions secrets** (a Railway token, a Modal token pair) only if rollouts should run from CI
  instead of from this machine. **Default:** they stay on this machine; CI runs the tests and builds the
  image on every push, which needs no secret from the user.

Run-time secrets are created inside Railway as sealed variables. The session signing key, the database
URL and production's operator token never leave it. **Three credentials do exist outside Railway**, and
are told here so that it is not a surprise (ARCHITECTURE 16.2, "Secrets"):

- the credential of the `dumps` bucket, as a Modal secret in environment `fsp`, so that the nightly job
  can copy the newest database dump off Railway and the audit can read its sampled journals. Railway
  cannot issue a read-only or folder-scoped bucket credential, so it is the full credential of that
  bucket; that is why the dumps have a bucket of their own, apart from the tile packs, and why no
  public-facing process holds it;
- the credential of the `packs` bucket, in this machine's `.env`, for uploading tile packs;
- the operator token of a load-test rehearsal environment, as a Modal secret for the bots, created and
  deleted with that environment. Production has no such use.

### Q6. How far the game may scale by itself, and how many players to provision for

Nothing scales by itself on stages 0 to 2. Only the launch topology (stage 3) has a controller that adds
shard services when the admission queue stays long, and it needs a ceiling: the most shards it may run
and the most it may spend in a day. A sustained 5,000 concurrent players is a $3,000-8,500 a month
service on current estimates, and its launch-heavy form is beyond the launch complex of the first release
(Q14).

**Default (stands):** a ceiling of 6 shards and $60 a day, and an admission cap of 500 at stage 2 until a
load test supports more. The lead confirms the ceiling with the user before stage 3 is provisioned for
the first time, with that day's measured numbers; nothing is spent on it before then.

### Q19. The larger load rehearsals

What is measured without asking: everything on the small stage (the idle floor, the cost at 5 players,
ramps up to about 200 simulated active players or the measured limit of the small stage, restart recovery
on the deployed database, the cold start). That is what the capacity report states as measured.

The split and the launch topologies (500 to 5,000 simulated players, automatic scale-out, the tile mirror
at launch size) can only be measured on the Pro plan:

| Rehearsal | Needs | Cost of one clean pass |
|---|---|---|
| The stage-up drill and the split (to 500 bots) | Pro for the month (the workspace then pays at least $20, which is $0-8 more than on Hobby) | About $10-20 on Railway; Modal bots inside the R&D allowance |
| The launch rehearsal (to 5,000 bots, scale-out, the mirror) | Pro | About $150: $45-100 of Modal bots (R&D), about $30 on Railway, up to $45 of billed mirror egress. A load test exists to fail, be fixed and run again, so two or three passes are likely |

What stays unmeasured without them, said plainly: how the 32 launch pads queue under a real crowd (the
small stage measures the cycle of one pad on a test rule set with 4 pads, and the 32-pad figure is
derived from it), simulation threads beyond 8, the memory of a large shard, and automatic scale-out.

**How and when this is asked (a fixed step, so that it cannot fall between two packages).** When the
small-stage programme ends in wave 6, `deploy-loadtest` writes `docs/capacity/<date>-stage0.md` and
files a request; the lead brings Q19 to the user with those measured numbers and the price, and records
the answer and its time here. On a yes the same package runs the two rehearsals. On a no, or with no
answer after 48 hours, it finishes, and the capacity report says in its first lines that the larger
stages are estimates whose correctness (not capacity) is tested on the local stack. A yes that comes
later re-opens the package for the rehearsals before the final gate.

> Asked: (not yet)   Answer: (none)

### Q17. Bodies the fleet cannot reach (asked only if the table says so)

The brief requires that players can reach and orbit every planet and major moon. The cruiser has 10.9 km/s
from low Earth orbit; the research puts Mercury, Io, Europa, the inner moons of Saturn, the moons of Uranus
and Triton between 11.1 and 13.8 km/s, and Ceres, Pluto and Charon were never computed. The plan is a
refuelled profile (the cruiser tops up at a depot in high Earth orbit or lunar orbit, which is worth about
3 km/s), flown as an acceptance flight, and a generated table that fails the build when any of the 32
bodies has no profile with a positive margin.

**Nothing is asked now.** If `fleet-data` cannot close the table by sizing the depot or adding a kick
stage, the remaining bodies are listed here with the options (a larger cruiser, a second refuel, an
exception stated to players), instead of being claimed as reachable.

### Small things (told, not asked; say if any is unwelcome)

- **The Docker VM's memory cap.** Before the first suite that needs Docker, the lead writes
  `%UserProfile%\.wslconfig` (6 GB, 8 processors, 2 GB of swap, memory reclaim on). It applies to every
  WSL 2 distribution on the machine, Ubuntu included, and takes effect after `wsl --shutdown`, so it is
  done at a moment when nothing runs.
  **Not done yet (2026-11-11).** The lead step `lead-baseline-v2` tried to write it at a moment when
  nothing ran (WSL 2.7.3; `Ubuntu` and `docker-desktop` both stopped; no `.wslconfig` existed; no Docker
  process), and the agent's permission system refused the action as one that interferes with other
  workloads; the refusal was respected. Nothing in waves 3 and 4 needs Docker (the local stack runs on
  host processes with an embedded Postgres); the first compose suites are in wave 5. Before then, either
  the user allows it or does it by hand: create `%UserProfile%\.wslconfig` with

  ```
  [wsl2]
  memory=6GB
  processors=8
  swap=2GB

  [experimental]
  autoMemoryReclaim=dropCache
  ```

  and run `wsl --shutdown`. To undo, delete the file and run `wsl --shutdown` again.
- **Railway's own usage e-mail** is a switch in the user's Railway account. Nothing depends on it. No
  hard usage limit is set: Railway's limit is per workspace, so reaching it would take the game, its
  buckets and `haulpoint-tms` offline. The month is bounded instead by per-service resource limits
  (about $100 if everything were pegged all month), the admission cap, and a daily allowance of bytes
  on every public route (about $40 a month if every allowance were used up every day): about $140 at
  the very most, and about $25 above normal for a month of scraping or a broken client (Q1).
- **The Hobby plan's included $5 is per workspace, and `haulpoint-tms` already uses it** (measured
  2026-11-10: $7.40 estimated for this billing period, $10.23 for the last). The game's bill is
  therefore its full usage on top of what the workspace pays anyway: $5-15 idle and $10-25 at 5 players
  (Q1, Q2).
- **Tile packs are also copied to a Modal volume** (about 14-20 GB, inside Modal's free storage), so
  that a copy exists outside the production bucket before `data/packs` is deleted from this machine.
- **The local Postgres is created as UTF-8 with a fixed locale**, like production's. The embedded
  package's default on this Windows machine would be the Windows-1252 code page.
- GitHub Actions minutes are finite on a private repository (2,000 a month on the free plan) and "Wait
  for CI" blocks deploys when they run out. CI is kept under 8 minutes per push.

---

## Outside the three providers: written now so it can be invoked the same day

The user offered an AWS account as a last resort. It is **not** needed on current evidence, and at the
small stage it cannot be: tiles cost nothing to serve from the Railway bucket at this scale. The decision
is prepared in advance for the launch sizes, with thresholds, so that it takes hours and not a failed
launch:

- **Measured in wave 3** (`platform-delivery`; free on the Railway side, because bucket egress is free):
  the Railway bucket at 20, 500 and 2,000 concurrent fetchers for 15 minutes. It **passes** with p95 first
  byte of a cold range at or under 400 ms, errors at or under 0.5 %, and 1.5 Gbit/s sustained in aggregate
  at 2,000 (an unanswered community report describes signed GETs slowing 3-7x at 100 concurrent fetches).
- **Also measured in wave 3**, from Chrome against the small stage: whether a browser can read the bucket
  at all (ranged GET with CORS under cross-origin isolation; forum threads report CORS failures, and on
  2026-07-01 a storage incident made presigned GETs fail for about a day), and what Railway's CDN does
  with `Range` requests. Railway said in July 2026 that its CDN now supports them; if the measurement
  agrees, the mirror proxies ranges, and if not it serves small slices (1-2 MB, not the 16 MB of an
  earlier version, which would have sent many times the bytes a visitor needs). Either way the mirror
  must send at most 1.5 bytes per byte needed.
- **Measured in the launch rehearsal** (Q19): the `packs` mirror at launch size. It **passes** with p95
  first byte at or under 600 ms, a CDN hit rate of 90 % or more, and billed egress at or under 0.15 GB per
  GB delivered.
- **Trigger:** the bucket fails at launch size **and** the mirror fails. The lead asks the user that day,
  with the measured numbers, before any launch is announced. The small stage is unaffected.
- **Inside the three, worst case:** tiles through the mirror with every request a miss. At the small
  stage this is capped by the mirror's daily allowance at **$12 a month**; when the allowance is used
  up, new visitors keep the title and their cached tiles and streaming stops for the day. (Uncapped it
  would be $15 a month at 5 players times the bytes sent per byte needed.) For a front-page day: $750
  to $1,125 (15 TB times that factor, to be recomputed from the measured first session), and $1,350 to
  $2,025 a month at sustained busy load.
- **Outside:** Cloudflare R2 behind a Cloudflare domain: about $0-35 for the same day (needs a Cloudflare
  account and a domain). AWS S3 + CloudFront flat-rate: $15 a month (Pro, 10 M requests) to $200 a month
  (Business, 125 M requests) with the coalesced pack requests this design makes; pay-as-you-go would be
  about $1,190 for the day.
- **Recommended default:** stay inside the three unless the trigger fires. The pack format, the mirror
  list and the client do not change if a fourth mirror is added.
