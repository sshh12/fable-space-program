# Open questions for the user (v2)

Decisions that are the user's: budget approvals, accounts and tokens, and product choices with real
trade-offs. Decisions already recorded in `docs/research/v2/user-decisions.md` (anonymous identity with a
seam for sign-ins, Railway + Netlify + Modal before anything else, the existing private GitHub repository)
are taken as given and not asked again.

The lead records each answer here (date, answer) under the question; work packages read this file to know
what is approved.

**Two kinds of question.** Product choices (Q7-Q17) have a recommended default that the work proceeds on,
so no package is blocked. **Q1, Q2 and Q4 are different: they block completion.** Without them nothing is
ever deployed and no load is ever measured, and three completion criteria of `PROMPT.txt` (the deployed
multiplayer experience, measured load limits, persistence proven on the deployed game) cannot be met. They
are asked now. Work continues on the local stack meanwhile, but no package may report a local-stack pass as
completion: `deploy-loadtest` and `final-gate` report "not deployed" to the user as a blocker.

**What may be spent without a new approval.** The existing $500 per provider allowance is for R&D, and the
following are R&D: Modal probes and throughput tests, bot rehearsals on Modal, bake jobs, audio generation.
They proceed inside that allowance once the Modal environment of Q4 is allowed to exist. **Hosting is not
R&D**: always-on Railway services, their egress, and the production deployment need Q1 and Q2.

Status of every figure: list prices fetched 2026-11-10 (`docs/research/v2/hosting.md`); capacity and cost
are **estimates** derived from one desktop core with an assumed 2.5x cloud derating, each given with a low
and a high value. Nothing has been measured on Railway. The first load test replaces them
(`docs/capacity/`).

---

## Summary: what is needed from the user

| # | Item | Needed by | Until answered |
|---|---|---|---|
| **Q1** (blocking) | Hosting budget: $150 a month standing, $400 spike reserve (+$750 tile worst case), $400 once for rehearsals; a Railway usage alert | **The end of wave 3** (the first cloud measurements and the topology skeleton); wave 6 cannot start without it | No hosting spend; local stack; completion blocked |
| **Q2** (blocking) | Railway Pro on the workspace; permission to create the project `fable-space-program`; a workspace-level API token for the scale controller | The end of wave 3; wave 6 | Nothing is created on Railway; completion blocked |
| Q3 | Shell host: Railway only, or Netlify (needs a Pro team, auto-recharge, a token, the CLI) | Wave 6 | Railway only |
| **Q4** (blocking for measured capacity) | Permission to create a dedicated Modal environment `fsp` | The end of wave 3; wave 6 | Bots run on the development machine (about 200): a local-only report with no front-page claim |
| Q5 | GitHub Actions secrets for deployment | Wave 6 | Rollouts are run from the development machine's logged-in CLIs |
| Q6 | The automatic scale ceiling (maximum shards, maximum dollars per day), and whether a sustained 5,000 is wanted | Before the public URL is shared | Ceiling: 6 shards and $60 a day; admission cap 500 until the load test supports more |
| Q7-Q17 | Product choices | See each | See each |
| Q18 | Where alerts go (a webhook or an address) | Wave 6 | Alerts are logged and shown on `/ops` only |

---

## Budget and accounts

### Q1. Hosting budget (blocking)

| Item | Amount | What it covers |
|---|---|---|
| Standing | **$150 a month** | The always-on split topology (gateway, directory, one shard, API, publisher, shell, pack mirror, Postgres with backups, buckets) at up to a few dozen concurrent players: estimated $90-115 a month, most of it memory. The margin covers the staging environment while it is awake (it sleeps when idle), dumps and nightly audits |
| Spike reserve | **$400** (plus **$750** worst case) | One front-page day at 5,000 concurrent players and 50,000 visitors: estimated $105-185 on the low CPU figure, $265-345 on the high one (socket egress alone is $54 at the planning average and $130 at the per-player cap, which a launch day reaches). The extra $750 is spent only if the free bucket path for tiles fails on the day and 15 TB falls back to billed egress; that figure rests on an assumed 300 MB per new visitor and is recomputed from a measured first session in wave 3 |
| Rehearsals | **$400 once** | One clean pass of the load-test programme and the throughput tests is about $150 (about 22,500 bot-hours on Modal, the Railway side, and up to 900 GB of billed mirror egress when the CDN misses). A load test exists to fail, be fixed and run again; every run prints the cumulative spend. The Modal part may instead draw on the existing R&D allowance |
| Sustained load (not requested now) | $420-1,020 a month at 500 concurrent held all month; $3,000-8,500 a month at 5,000 | See Q6 |

Also needed with this approval:

- **A Railway usage alert** set by the user (for example at $100 and $300 in a month).
- **A deliberate decision on a hard usage limit.** A hard limit protects against a runaway bill and takes
  the game offline when it is reached, which would be in the middle of the spike it exists for. Recommended:
  no hard limit, the alert, and the scale ceiling of Q6.
- GitHub Actions minutes are finite on a private repository (2,000 a month on the free plan) and "Wait for
  CI" blocks deploys when they run out. CI is kept under 8 minutes per push; say if the plan differs.

**Recommended:** approve the three amounts. Until then no cloud resource is created; every package
verifies against the local stack (Docker: Postgres and an S3-compatible store), the deploy and measurement
steps are single scripted commands that wait, and completion is blocked as stated above.

### Q2. Railway (blocking)

- The CLI is logged in but does not report the plan. The design needs **Pro** ($20 a month, which includes
  $20 of usage): replicas of 24 vCPU / 24 GB, 100 services per project, volumes above 5 GB, 30-day logs.
- Needed: confirmation of Pro; permission to create a new project named `fable-space-program` (the existing
  `haulpoint-tms` project is never touched); and an API token that can **create services** in that project
  for the scale controller and the rollout script. A project token is probably not enough for that and a
  workspace-level token is probably needed; this is verified in wave 3 with the skeleton, and the token is
  stored as a sealed variable.
- Simulation services are deployed by image digest through a script, not by autodeploy; the Railway GitHub
  App is needed only for the stateless services (`api`, `pub`, `shell`, `packs`).

**Recommended:** yes to all. Until then: local stack only.

### Q3. Where the static shell is served

| Option | Cost (quiet / 500 players / 5,000) | Needs from the user | Gains | Loses |
|---|---|---|---|---|
| **A. Railway only** (the `shell` service with Railway's CDN) | about $1 / $5 / $30 a month | Nothing | One account, one deploy system, no credit-exhaustion failure mode | Deploy previews and instant rollback of the shell; Railway's CDN is beta |
| B. Netlify for the shell | $20 / about $80 / $135-420 a month | A Pro team ($20 a month), **auto-recharge switched on** by the team owner (without it the site is paused when credits run out), `NETLIFY_AUTH_TOKEN` and a site id as GitHub secrets, `npm i -g netlify-cli` | A mature CDN for first paint, deploy previews | An extra account and a second failure mode on a spike |

Neither option changes the game: tiles, sky data and assets never go through Netlify in either (its
bandwidth would cost about $2,000 for a front-page day).

**Recommended default: A.** No Netlify configuration file is shipped untested: if the user chooses B, the
configuration is written and validated then (a dry build with the CLI and a header test), and switching is
a DNS change. Netlify stays part of the design as an option, as the brief allows a combination.

### Q4. Modal (blocking for measured capacity)

- Needed: permission to create a dedicated environment `fsp` with apps prefixed `fsp-` (bots, audits,
  bakes, probes). The four existing apps and the existing volumes in `main` are never touched.
- The Starter plan allows 100 containers for the whole workspace, shared with the existing apps. The bot
  fleet therefore runs 100 or more bots per 4-core container (50 containers or fewer for 5,000 bots), and
  the throughput probe is expressed as concurrent fetchers per container, so the existing apps keep their
  headroom.

**Recommended:** yes. Until then bots run on the development machine through the heavy-job gate, and the
capacity report is local-only.

### Q5. Deployment secrets

For GitHub Actions to build the image and roll it out: the Railway token of Q2, a Modal token pair, and
(only with Q3 option B) the Netlify token and site id, added by the user as repository secrets. Run-time
secrets (session signing key, bucket credentials, database URL, the operator token) are created inside
Railway as sealed variables and never leave it.

**Recommended default:** until the secrets exist, rollouts are run from this machine's logged-in CLIs by
the deploy package; CI still runs tests on every push.

### Q6. How far the game may scale by itself, and how many players to provision for

- The production topology is always split (gateway, directory, shards, API, publisher), so growing is
  adding shard services and gateway replicas; nothing restarts. Railway has no autoscaler, so a small
  controller does it when the admission queue stays long, and scales back in when it is quiet. **It needs a
  ceiling from the user**: the most shards it may run and the most it may spend in a day.
- A sustained 5,000 concurrent players is a $3,000-8,500 a month service on current estimates (egress and
  memory are the largest lines), and the capacity behind it is unmeasured. Its launch-heavy form is also
  beyond the launch complex of the first release (Q14).

**Recommended default:** a ceiling of 6 shards and $60 a day (inside the spike reserve of Q1) until the
load-test report exists, then the measured count for 5,000; an admission cap of 500 until the load test
supports more (players beyond it queue in the menu and can watch); decide on sustained capacity after the
report.

---

## Product choices

### Q7. How far ahead a stranger may take someone's parked ship or station (`advanceLimit`)

The time model is forward-only: when a player who is ahead in time docks with a parked station, the
station's time moves to theirs and players behind must jump forward to reach it. Each owner's
`advanceLimit` bounds this, in two ways: nobody can claim a parked craft beyond it, and a clock that already
carries the craft (docked to it, flying its vacant helm, with its owner idle or disconnected) cannot run
beyond it either unless the owner explicitly agrees. An assembly's limit is the lowest limit among its
owned craft.

| Option | Ships / station modules | Effect |
|---|---|---|
| A | 7 days / 30 days | The launch crowd almost always finds hubs in its own present. Anyone back from Mars (about 2 years ahead) or Saturn (about 12) can never dock that ship with someone else's station |
| **B** | **30 days / 6 years** | A Mars or Jupiter round-tripper can dock with shared stations. One such visitor can move a shared station up to 6 years ahead; everyone else then needs one keypress (a jump) to follow, and leaves the live clock by doing so. A 30-day ferry parked on the station holds the whole station to 30 days until its owner raises the limit or leaves |
| C | Unlimited (to the 250-year cap) | Every returnee can dock; one player can strip the live crowd of every shared station |

**Recommended default: B**, with the owner able to change the value per craft. It is a rules field, not
code; this is the number most likely to change after play-testing.

**Play-test (owner: the lead, between waves 5 and 6).** Two browsers, the defaults of U6, U8 and U9
(ready-check 15 s, idle 120 s, the jump and advance offers), the stories of ARCHITECTURE 28.5. The result,
with any changed rule value and the measured share of the lobby that is mutually solid from the load test,
is written here:

> Result: (not yet run)

### Q8. Second launch site

- Option A (recommended): a second site on the Arabian Sea coast of Oman near 19.0 N 57.8 E, at the same
  latitude as Ka Lae and 14.2 hours of solar time away, so a daylit pad exists at almost any hour and both
  sites reach the same orbit planes. Cost: one regional Earth bake (hours of machine time, about 1.5 GB of
  disk; about 30 m elevation data there, against 10 m at Ka Lae) and a structures file.
- Option B: all 32 pads along the coast inside the existing Ka Lae region. No bake; no daylight benefit:
  with one shared clock the only site is dark half of every day.

**Recommended default: A**, falling back to B if no acceptable ground is found near the nominal point or if
the 30 m data cannot meet the v1 standard at pad level (the bake's hand-off and the ground checkpoints at
the new pads decide; ARCHITECTURE 31.3).

### Q9. Free-text chat

Rendezvous needs coordination, and an anonymous free-text channel at front-page scale needs moderation
(filter, mute, block, reports, someone to read them).

**Recommended default:** quick-comms only (fixed, contextual phrases; nothing to moderate). Free-text chat
is not built and there is no switch for it; the design for it (`frontend-ux.md` 6.6) is kept as a forward
seam. Say if it is wanted, and it becomes a package with its moderation tools.

### Q10. Publishing the tile packs as a public Hugging Face dataset

A free secondary mirror that works from a browser. It needs a dataset card and a licence check: the
regional Earth imagery is Sentinel-2 cloudless, CC BY-NC-SA 4.0.

**Recommended default: no.** Mirrors are the Railway bucket and the `packs` service. Revisit only if the
bucket throughput test fails.

### Q11. Earth imagery licence (existing since v1, now public)

The regional Earth albedo around both sites is Sentinel-2 cloudless (CC BY-NC-SA 4.0): fine for a free,
non-commercial game with attribution on the Credits screen (which is built, and lists every source of the
bakes, the audio and the font); not fine if the game is ever monetised.

**Recommended default:** keep it, credit it, and treat a swap of the regional imagery source (the bake is
config-driven) as a precondition of any monetisation.

### Q12. Desktop browsers other than Chrome and Edge

A browser that passes every gate check (WebGPU, features, limits) could be allowed with a "not tested on
this browser" banner, or blocked.

**Recommended default:** allow with the banner. Mobile and tablets are always blocked.

### Q13. Server region

One region holds the universe. US East (Virginia) gives North America and Europe 40-120 ms of round trip;
Asia and Australia see about 250 ms. A second region would be a second, separate lobby.

**Recommended default:** US East.

### Q14. Player-facing rule values, and the size of the launch complex

All are fields of `UniverseRules`, shown on the "How this universe works" screen, and changeable without
code. The proposed defaults:

| Rule | Default |
|---|---|
| A ship is kept | 14 days after its owner's last session (any login renews all of the owner's ships) |
| When the universe is nearly full | Ships of players who visited once are removed first (never sooner than 24 h after their visit), before any launch is refused |
| Ship slots per account | 10 |
| A station (assembly) is kept | as long as its most recently active owner's ships; 48 h after the last owner lapses it is removed whole |
| Debris is removed | 2 hours after it was last near an attended craft; at most 24 pieces per account |
| An account with no ships | deleted after 90 days without a visit |
| Farthest a player may warp ahead of the live clock | 250 years |
| Time on a pad | 300 s, one 120 s extension while engines run |
| Launch pads | **32 (16 per site)** |
| Furthest future launch slot offered when pads are busy | **14 days ahead** |

**The launch complex is the first thing a front-page day runs into, and its size is a product choice.**
One pad launches about 24 rockets an hour. Every player's clock runs at real speed, so 32 pads give 768
launches an hour for ever, plus a one-time reservoir of future slots (258,000 with a 14-day horizon) that a
spike can draw on. Together that is 276,000 launches in the first day: enough for a front-page day of
240,000 sessions with one launch each. The price of the reservoir: during a spike players start up to 14
days ahead of the live clock, 64 to a time slot, and see the live crowd as echoes until someone jumps.

| Option | Pads | Horizon | First-day launches | Sustained per hour | Cost |
|---|---|---|---|---|---|
| A | 16 | 24 h | 18,400 | 384 | The original plan: 8 % of a front-page day's sessions could launch |
| B | 16 | 26 days | 249,000 | 384 | No extra pads to build; players up to 26 days ahead |
| **C** | **32** | **14 days** | **276,000** | **768** | Twice the pad structures and pad resolve runs (generated per class; no extra bake) |
| D | 64 | 6 days | 258,000 | 1,536 | Four times the pads; about 32 per site is near what the baked coast holds at the stated spacing |

A **sustained** launch-heavy 5,000 concurrent players would need 200-400 pads (about ten sites) and is not
offered by the first release; the rules screen states the wait at the measured limit.

**Recommended default: C**, with the other values as listed.

### Q15. First-person view on craft without a cabin, and the Egret's cockpit

The original brief asks for three views including a first-person cockpit with a real interior. Only the
Kestrel capsule has an interior. Three vehicles fly with it (the Egret reuses it: its cabin is designed on
the same mould line). **Five of the eight vehicles have no cabin**: the Pathfinder probe, the Pelican tug
and the depot (uncrewed), and two crewed modules, the Albatross habitat (4 crew) and the Atoll station
core (6 crew). The Albatross carries the whole interplanetary experience.

| Option | What the player gets on those five | Cost |
|---|---|---|
| **A** | A **sensor-camera view**: a forward camera at the command part's camera mount with the instrument pages (navball, target, docking) composed around the frame, labelled as a remote view. It is a designed, tested first-person view, not an absence; the hangar card says "first person: sensor camera" | Inside the current packages |
| B | A, plus real cabin interiors for the Albatross habitat and the Atoll core, to the standard of the Kestrel | Two more cockpit interiors: about the size of the wave-2 cockpit package each |
| C | A, plus an interior for the Albatross only | One more interior |

**Recommended default: A**, with the Egret reusing the Kestrel interior. This limits an original
requirement for five vehicles, so it is the user's call; B or C would be an additional package after
wave 5.

### Q16. Offline practice mode, telemetry, domain

- **Offline practice**: the in-process universe that the tests use is offered from the hub ("Practice
  (offline)") and when the server is unreachable. It is built by `shell-menu` (menu entry, a `LocalSession`
  on the local rule set, the fallback in the reconnecting state) and tested by keyboard.
  **Recommended default:** offer it.
- **Telemetry**: the client sends a CPU score (used to move planning work to the server for weak machines)
  and, on a block page, nothing. No analytics. **Recommended default:** keep it that way.
- **Custom domain**: optional; provider domains work. **Recommended default:** provider domains until the
  user supplies a domain and DNS access.

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

### Q18. Where alerts go

The scale controller and the directory raise alerts (admission queue, step time, connections, the universe
filling up, the day's spend, every scale action). **Needed:** a webhook URL (Discord, Slack) or an email
address. **Default until answered:** alerts are logged and shown on the operator page only, so nobody is
told when a spike starts; the controller still scales inside the ceiling of Q6.

---

## Outside the three providers: written now so it can be invoked the same day

The user offered an AWS account as a last resort. It is **not** needed on current evidence. The decision is
prepared in advance, with thresholds, so that it takes hours and not a failed launch:

- **Measured in wave 3** (`platform-delivery`), at 500 and 2,000 concurrent fetchers for 15 minutes:
  - the Railway bucket **passes** with p95 first byte of a cold range at or under 400 ms, errors at or under
    0.5 %, and 1.5 Gbit/s sustained in aggregate (an unanswered community report describes signed GETs
    slowing 3-7x at 100 concurrent fetches);
  - the `packs` mirror **passes** with p95 first byte at or under 600 ms, a CDN hit rate of 90 % or more,
    and billed egress at or under 0.15 GB per GB delivered (Railway's CDN does not key on `Range`; if it
    does not slice ranged reads the mirror serves 16 MB slice objects).
- **Trigger:** the bucket fails **and** the mirror fails. The lead asks the user that day, with the
  measured numbers.
- **Inside the three, worst case:** tiles through the `packs` service with every request a miss: $750 for
  a front-page day (15 TB, to be recomputed from the measured first session), up to $1,350 a month at
  sustained busy load.
- **Outside:** Cloudflare R2 behind a Cloudflare domain: about $0-35 for the same day (needs a Cloudflare
  account and a domain). AWS S3 + CloudFront flat-rate: $15 a month (Pro, 10 M requests) to $200 a month
  (Business, 125 M requests) with the coalesced pack requests this design makes; pay-as-you-go would be
  about $1,190 for the day.
- **Recommended default:** stay inside the three unless the trigger fires. The pack format, the mirror
  list and the client do not change if a fourth mirror is added.
