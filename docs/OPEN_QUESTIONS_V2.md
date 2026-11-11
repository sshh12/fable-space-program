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
  bake jobs, audio generation, and short-lived rehearsal environments that fit the Hobby plan (cents to a
  few dollars each).
- **Not without the lead telling the user first**: the Pro plan, any step that raises the standing spend,
  and any rehearsal that needs more than the Hobby plan allows.

Status of every figure: list prices fetched 2026-11-10 and 2026-11-11 (`docs/research/v2/hosting.md`,
`hosting-small.md`); capacity and cost are **estimates**, each given with a low and a high value; the
memory figures of the small stage were measured on the development machine. Nothing has been measured on
Railway. The first measurements replace them (`docs/capacity/`).

---

## Summary

| # | Item | Status | The work proceeds on |
|---|---|---|---|
| Q1 | Hosting budget | **Answered 2026-11-11** | About $50 a month or less at about 5 players on the Hobby plan; about $30 or less idle; more only on measured need, announced first |
| Q2 | Railway project and plan | Project: **answered 2026-11-11**. Plan: **open** (when to move to Pro; backups from the first day?) | Hobby, with our own hourly dumps; Pro when measured usage reaches about $20 a month |
| Q3 | Shell host | Default stands (2026-11-11) | Railway only |
| Q4 | Modal environment | **Answered 2026-11-11** | Environment `fsp`; existing apps untouched |
| Q5 | Deploy access | **Open** (a click by the user; nothing is blocked) | Rollouts from the development machine's logged-in CLIs |
| Q6 | Automatic scale ceiling; sustained 5,000 | Default stands; it applies only from stage 3 | 6 shards and $60 a day, confirmed with the user before stage 3 is provisioned |
| Q7-Q16 | Product choices | Defaults stand (2026-11-11) | The defaults listed below |
| Q17 | Bodies the fleet cannot reach | Asked only if the reachability table says so | - |
| Q19 | The larger load rehearsals | **Open** | Stage-0 measurements only; larger sizes reported as estimates |
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
| About $50 a month or less at about 5 concurrent players, everything included | **$9-22 a month** with 5 players held all month on stage 0 (one `game` process, `shell`, Postgres, an hourly dump job, one bucket; Modal inside its free credit) | Projected from measured usage on the deployed stage by `deploy-loadtest` and again by `final-gate`: an acceptance criterion |
| About $30 a month or less when nobody plays | **$5-10 a month**, the Hobby fee included. Nothing sleeps: an empty universe runs no tick loop, no simulation threads and holds no terrain, so the first visitor after any quiet spell waits for nothing | The same measurement, 12 hours with nobody connected |
| Scale from there by configuration and deploys | A ladder of four stages on one codebase; each move has a measured trigger and at most one announced freeze of under 40 s plus the resume window; committed state is never lost | The moves are tested on the local stack and timed in a drill |

What the small stage does not do, so that it is not a surprise: **a front-page day that arrives
unannounced is not absorbed automatically**, and with no alerts nobody is told. The first 20 players play
normally (the cap that keeps the conservative projection at about $50 a month); everyone else gets the
title, the live view and a place in the queue. Such a day costs about $3-10. Moving up to the launch
topology takes about an hour of a human's time once somebody looks, and needs the Pro plan. An announced
launch is moved up the day before.

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
  suites that need the pinned Linux image: restart, recovery and replay, and the image smoke test.
- **Scale to zero** is used only where it is free of risk: Modal, the dump job, and rehearsal
  environments that exist only while a measurement runs. The production server does not sleep; its idle
  floor is the $5-10 above.
- **No alerts for now.** No alert routing is built and no destination is asked for. The numbers an alert
  would watch are on the operator page and in the capacity reports. Alerting is a later addition
  (ARCHITECTURE 32).

### Defaults the user let stand (2026-11-11)

"The other defaults in OPEN_QUESTIONS_V2.md stand." Each is a rules field or a data choice and can still
be changed later.

| # | Choice | In force |
|---|---|---|
| Q3 | Where the static shell is served | The `shell` service on Railway with Railway's CDN (about $0.5-1 a month at stage 0). Netlify stays an option for the shell only; it would need a Pro team with auto-recharge, a token, a site id and the CLI, and no Netlify configuration is shipped untested |
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

| Option | Monthly bill at 0-5 players | If the database volume is lost | Also brings |
|---|---|---|---|
| **A. Hobby now** (default) | $5-22 | Up to about 1 hour lost | - |
| B. Pro from the first day | $20-22 | Minutes (point-in-time recovery), plus daily, weekly and monthly backups | Deploys of one image by digest, 30-day logs, larger volumes and replicas. The upgrade covers the whole workspace, `haulpoint-tms` included |

**Default: A.** The lead tells the user when measured usage reaches about $20 a month, because from there
Pro costs exactly what Hobby costs (both bill the larger of the fee and the usage), or when the database
passes 4 GB of the Hobby plan's 5 GB. The upgrade itself is the user's click; the switch-over afterwards
is scripted and freezes the universe for seconds at most.

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

Run-time secrets (session signing key, bucket credentials, database URL, the operator token) are created
inside Railway as sealed variables and never leave it.

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
| The stage-up drill and the split (to 500 bots) | Pro for the month ($20, against the $5-10 the small stage costs anyway) | About $10-20 on Railway; Modal bots inside the R&D allowance |
| The launch rehearsal (to 5,000 bots, scale-out, the mirror) | Pro | About $150: $45-100 of Modal bots (R&D), about $30 on Railway, up to $45 of billed mirror egress. A load test exists to fail, be fixed and run again, so two or three passes are likely |

**Default:** neither is run until the lead has come back with the measured small-stage numbers and the
price, and the user has said yes. Until then the capacity report says in its first lines that the larger
stages are estimates whose correctness (not capacity) is tested on the local stack.

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
- **Railway's own usage e-mail** is a switch in the user's Railway account. Nothing depends on it. No
  hard usage limit is set, because reaching it would take the game and the tile bucket offline; the bill
  is bounded by per-service resource limits (about $100 a month if everything were pegged all month) and
  the admission cap instead.
- **The Hobby plan's included $5 is per workspace.** If `haulpoint-tms` already uses it, the game's bill
  is its full usage on top of the fee the workspace pays anyway: $3.5-9.7 idle and $8.7-21.8 at 5 players.
  This is read from the account when the project is created.
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
- **Measured in the launch rehearsal** (Q19): the `packs` mirror at launch size. It **passes** with p95
  first byte at or under 600 ms, a CDN hit rate of 90 % or more, and billed egress at or under 0.15 GB per
  GB delivered (Railway's CDN does not key on `Range`, so the mirror serves 16 MB slice objects).
- **Trigger:** the bucket fails at launch size **and** the mirror fails. The lead asks the user that day,
  with the measured numbers, before any launch is announced. The small stage is unaffected.
- **Inside the three, worst case:** tiles through the mirror with every request a miss: $15 a month at 5
  players; $750 for a front-page day (15 TB, to be recomputed from the measured first session), up to
  $1,350 a month at sustained busy load.
- **Outside:** Cloudflare R2 behind a Cloudflare domain: about $0-35 for the same day (needs a Cloudflare
  account and a domain). AWS S3 + CloudFront flat-rate: $15 a month (Pro, 10 M requests) to $200 a month
  (Business, 125 M requests) with the coalesced pack requests this design makes; pay-as-you-go would be
  about $1,190 for the day.
- **Recommended default:** stay inside the three unless the trigger fires. The pack format, the mirror
  list and the client do not change if a fourth mirror is added.
