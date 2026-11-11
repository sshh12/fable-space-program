# Open questions for the user (v2)

Decisions that are the user's: budget approvals, accounts and tokens, and product choices with real
trade-offs. Each has a **recommended default** that the work proceeds on until the user says otherwise, so
no package is blocked. Decisions already recorded in `docs/research/v2/user-decisions.md` (anonymous
identity with a seam for sign-ins, Railway + Netlify + Modal before anything else, the existing private
GitHub repository) are taken as given and not asked again.

The lead records each answer here (date, answer) under the question; work packages read this file to know
what is approved.

Status of every figure: list prices fetched 2026-11-10 (`docs/research/v2/hosting.md`); capacity and cost
are **estimates** derived from one desktop core with an assumed 2.5x cloud derating. Nothing has been
measured on Railway. The first load test replaces them (`docs/capacity/`).

---

## Summary: what is needed from the user

| # | Item | Needed by | Default until answered |
|---|---|---|---|
| Q1 | Hosting budget: $100 a month standing, $300 spike reserve (+$750 worst case), $150 once for rehearsals | First cloud measurement (wave 3) | No cloud spend; everything runs on the local stack |
| Q2 | Railway Pro on the workspace and permission to create the project `fable-space-program` and install the Railway GitHub App on the repository | Wave 3 measurements; wave 6 deployment | Nothing is created on Railway |
| Q3 | Shell host: Railway only, or Netlify (needs a Pro team, auto-recharge, a token, the CLI) | Wave 6 | Railway only |
| Q4 | Permission to create a dedicated Modal environment `fsp` | Wave 3 measurements; wave 6 bots | Bots run on the development machine (about 200) |
| Q5 | GitHub Actions secrets for deployment | Wave 6 | Deploys are run from the development machine's logged-in CLIs |
| Q6 | How many players to provision for, and whether a sustained 5,000 is wanted | Before any announcement | Stage A always on; admission cap 500 until the load test supports more |
| Q7-Q16 | Product choices | See each | See each |

---

## Budget and accounts

### Q1. Hosting budget

The $500 per provider allowance is for R&D. Hosting needs its own approval.

| Item | Amount | What it covers |
|---|---|---|
| Standing | **$100 a month** | Stage A (one always-on service with every role, the API, Postgres with backups, the `edge` service, buckets) at up to a few dozen concurrent players: estimated $45-75 a month. The margin covers the staging environment and nightly audits |
| Spike reserve | **$300** (plus **$750** worst case) | One front-page day at 5,000 concurrent players and 50,000 visitors: estimated $105-140, or $215-255 on the conservative CPU figure. The extra $750 is spent only if the free bucket path for tiles fails on the day and 15 TB falls back to billed egress |
| Rehearsals | **$150 once** | Bucket throughput tests and the load-test ramps to 5,000 bots (a one-hour 5,000-bot run is about $13 on Modal plus about $9 on Railway) |
| Sustained load (not requested now) | $355-580 a month at 500 concurrent held all month; $2,700-4,650 a month at 5,000 | See Q6 |

**Recommended default:** approve the three amounts above. Until then no cloud resource is created and no
money is spent; every package verifies against the local stack (Docker: Postgres and an S3-compatible
store), and the deploy and measurement steps are single scripted commands that wait.

### Q2. Railway

- The CLI is logged in but does not report the plan. The design needs **Pro** ($20 a month, which includes
  $20 of usage): replicas of 24 vCPU / 24 GB, 100 services per project, volumes above 5 GB, 30-day logs.
- Needed: confirmation of Pro, permission to create a new project named `fable-space-program` (the existing
  `haulpoint-tms` project is never touched), and installation of the Railway GitHub App on
  `sshh12/fable-space-program` for autodeploy.

**Recommended default:** yes to all three. Until then: local stack only.

### Q3. Where the static shell is served

| Option | Cost (quiet / 500 players / 5,000) | Needs from the user | Gains | Loses |
|---|---|---|---|---|
| **A. Railway only** (the `edge` service with Railway's CDN) | about $1 / $5 / $30 a month | Nothing | One account, one deploy system, no credit-exhaustion failure mode | Deploy previews and instant rollback of the shell; Railway's CDN is beta |
| B. Netlify for the shell | $20 / about $80 / $135-420 a month | A Pro team ($20 a month), **auto-recharge switched on** by the team owner (without it the site is paused when credits run out), `NETLIFY_AUTH_TOKEN` and a site id as GitHub secrets, `npm i -g netlify-cli` | A mature CDN for first paint, deploy previews | An extra account and a second failure mode on a spike |

Neither option changes the game: tiles, sky data and assets never go through Netlify in either (its
bandwidth would cost about $2,000 for a front-page day).

**Recommended default: A.** `deploy/netlify.toml` is kept ready with the required headers; switching later
is a DNS change. Netlify stays part of the design as an option, as the brief allows a combination.

### Q4. Modal

- Needed: permission to create a dedicated environment `fsp` with apps prefixed `fsp-` (bots, audits,
  bakes, probes). The four existing apps and the existing volumes in `main` are never touched. The Starter
  plan is enough (100 containers at about 50 bots each is 5,000 bots).

**Recommended default:** yes. Until then bots run on the development machine through the heavy-job gate.

### Q5. Deployment secrets

For GitHub Actions to deploy: a Railway project token, a Modal token pair, and (only with Q3 option B) the
Netlify token and site id, added by the user as repository secrets. Run-time secrets (session signing key,
bucket credentials, database URL) are created inside Railway as sealed variables and never leave it.

**Recommended default:** until the secrets exist, deployments are run from this machine's logged-in CLIs by
the deploy package; CI still runs tests on every push.

### Q6. How many players to provision for

- Railway has no autoscaler. Stage B (gateways, directory, shards as separate services) is entered by a
  script before an announced date; idle shards cost only their memory.
- A sustained 5,000 concurrent players is a $2,700-4,650 a month service on current estimates (egress is the
  largest line), and the capacity behind it is unmeasured.

**Recommended default:** stage A always on with an admission cap of 500 (players beyond it queue in the
menu and may spectate); pre-scale to stage B only for a date the user names; decide on sustained capacity
after the load-test report. If a front-page day arrives unannounced, the scale script is run by hand and
the spike reserve of Q1 applies.

---

## Product choices

### Q7. How far ahead a stranger may take someone's parked ship or station (`advanceLimit`)

The time model is forward-only: when a player who is ahead in time docks with a parked station, the
station's time moves to theirs and players behind must jump forward to reach it. The owner's
`advanceLimit` bounds this.

| Option | Ships / shared stations | Effect |
|---|---|---|
| A | 7 days / 30 days | The launch crowd almost always finds hubs in its own present. Anyone back from Mars (about 2 years ahead) or Saturn (about 12) can never dock that ship with someone else's station |
| **B** | **30 days / 6 years** | A Mars or Jupiter round-tripper can dock with shared stations. One such visitor can move a shared station up to 6 years ahead; everyone else then needs one keypress (a jump) to follow, and leaves the live clock by doing so |
| C | Unlimited (to the 250-year cap) | Every returnee can dock; one player can strip the live crowd of every shared station |

**Recommended default: B**, with the owner able to change the value per vessel. It is a rules field, not
code; this is the number most likely to change after play-testing.

### Q8. Second launch site

- Option A (recommended): a second site on the Arabian Sea coast of Oman near 19.0 N 57.8 E, at the same
  latitude as Ka Lae and 14.2 hours of solar time away, so a daylit pad exists at almost any hour and both
  sites reach the same orbit planes. Cost: one regional Earth bake (hours of machine time, about 1.5 GB of
  disk; about 30 m elevation data there) and a structures file.
- Option B: eight more pads up the coast inside the existing Ka Lae region. No bake; no daylight benefit:
  with one shared clock the only site is dark half of every day.

**Recommended default: A**, falling back to B if no acceptable ground is found near the nominal point.

### Q9. Free-text chat

Rendezvous needs coordination, and an anonymous free-text channel at front-page scale needs moderation
(filter, mute, block, reports, someone to read them).

**Recommended default:** quick-comms only (fixed, contextual phrases; nothing to moderate). Free-text
proximity chat is designed (`frontend-ux.md` 6.6) and sits behind a rules flag that is off.

### Q10. Publishing the tile packs as a public Hugging Face dataset

A free secondary mirror that works from a browser. It needs a dataset card and a licence check: the
regional Earth imagery is Sentinel-2 cloudless, CC BY-NC-SA 4.0.

**Recommended default: no.** Mirrors are the Railway bucket and the `edge` service. Revisit only if the
bucket throughput test fails.

### Q11. Earth imagery licence (existing since v1, now public)

The regional Earth albedo around both sites is Sentinel-2 cloudless (CC BY-NC-SA 4.0): fine for a free,
non-commercial game with attribution on the credits screen; not fine if the game is ever monetised.

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

### Q14. Player-facing rule values

All are fields of `UniverseRules`, shown on the "How this universe works" screen, and changeable without
code. The proposed defaults:

| Rule | Default |
|---|---|
| A ship is kept | 14 days after its owner's last session (any login renews all of the owner's ships) |
| Ship slots per account | 10 |
| A station (assembly) is kept | as long as its most recently active owner's ships |
| Debris is removed | 2 hours after it was last near an attended craft; at most 24 pieces per account |
| An account with no ships | deleted after 90 days without a visit |
| Farthest a player may warp ahead of the live clock | 250 years |
| Time on a pad | 300 s, one 120 s extension while engines run |
| Launch pads | 16 (8 per site) |

**Recommended default:** as listed.

### Q15. The Egret lunar ferry's cockpit

Only the Kestrel capsule has an interior. The Egret can reuse it unchanged (its cabin is designed on the
same mould line), or get its own interior (one more cockpit to build to the v1 standard).

**Recommended default:** reuse the Kestrel interior. The cruiser and the uncrewed craft have no cockpit
view; crew reach the cruiser by ferry.

### Q16. Offline practice mode, telemetry, domain

- **Offline practice**: the in-process universe that the tests use can be offered from the menu ("Practice
  (offline)"), and automatically when the server is unreachable. It costs a menu entry.
  **Recommended default:** offer it.
- **Telemetry**: the client sends a CPU score (used to move planning work to the server for weak machines)
  and, on a block page, nothing. No analytics. **Recommended default:** keep it that way.
- **Custom domain**: optional; provider domains work. **Recommended default:** provider domains until the
  user supplies a domain and DNS access.

---

## Not requested now: a CDN or object store outside the three providers

The user offered an AWS account as a last resort. It is **not** needed on current evidence. The trigger and
the numbers, so the decision can be made quickly if the trigger fires:

- **Trigger:** the wave-3 throughput test of the Railway bucket fails at front-page concurrency (an
  unanswered community report describes signed GETs slowing 3-7x at 100 concurrent fetches) **and** the
  `edge` mirror's CDN hit rate is poor.
- **Inside the three, worst case:** tiles through the `edge` service with every request a miss: $750 for a
  front-page day (15 TB), up to $1,350 a month at sustained busy load.
- **Outside:** Cloudflare R2 behind a Cloudflare domain: about $0-35 for the same day (needs a Cloudflare
  account and a domain). AWS S3 + CloudFront flat-rate: $15 a month (Pro, 10 M requests) to $200 a month
  (Business, 125 M requests) with the coalesced pack requests this design makes; pay-as-you-go would be
  about $1,190 for the day.
- **Recommended default:** stay inside the three; ask the user only when the trigger fires, with the
  measured numbers.
