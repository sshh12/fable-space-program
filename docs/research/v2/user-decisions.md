# Decisions from the user (binding for the v2 design)

Recorded by the lead on 2026-11-11 while the v2 design workflow was running. Proposal authors, judges and the
architect: these override any contrary recommendation in the research files.

## Identity

Keep it simple: **anonymous identity by default** (no sign-up, no email), with the **ability to add fancier
sign-ins later**. Design the identity layer as a seam: an account record that an anonymous device credential
points at today and that other sign-in methods can be linked to later, without migrating ships or changing
the protocol. Do not build any sign-in provider now.

## Hosting providers

Build on **Railway, Netlify and Modal**. The user is confident that their combined product surface covers
everything this game needs, including delivery of the planet tile data (about 15 GB, about 400,000 files
today). Find the way to do it within those three before proposing anything else.

Only if a workload truly cannot be served affordably by the three: the user can plug in an **AWS account**
as a last resort. In that case put the case in `docs/OPEN_QUESTIONS_V2.md` with cost numbers for both
options; do not design around AWS by default.

Account state on this machine: `railway` and `modal` CLIs are logged in; the Netlify CLI is not installed
and there is no Netlify token in `.env`, so a design that uses Netlify must list what the user has to
provide.

## Repository

The GitHub repository exists: https://github.com/sshh12/fable-space-program (private, `main` pushed, remote
`origin`). Deploy pipelines can assume it. Keep credentials out of it and out of the client.

## Compute split

"For multiplayer and backend it could also be interesting to consider architectures that let us offload
computation server side or optimally pick a balance there." Treat the client/server compute split as a
first-class design decision with numbers, not a default.

## Future direction (no added scope now)

A KSP-style ship builder and further KSP-like systems are expected later. Future-proof the part, vehicle and
assembly model for them; do not build them.

## Cost floor and scaling (2026-11-11, after reading the v2 design)

The user accepted the v2 design ("This is fine") with one change, verbatim: "we need to be able to run with
like 5 players at much less, like $50/mo and then scale from there. I have railway hobby for now but we can
upgrade and scale as we need to but shouldn't need for small scale. With that you have permission to set
everything up."

What this means for the design:

- **The always-on deployment must cost about $50 a month or less in total at about 5 concurrent players**,
  everything included (simulation, persistence, static front end, tile delivery, the Railway plan fee).
  The earlier "always in the split topology" base of $90-115 a month is rejected as the starting point.
- **It must run on the Railway Hobby plan** as it stands today. Check the Hobby plan's real limits and
  prices before relying on any feature (replicas, buckets, volumes, private networking, CDN, usage caps).
- **Scale from there**: the same code and data must grow to the busy and front-page configurations by
  configuration and deploys, not by a rewrite. Moving up may need the Pro plan and more spend; that is
  acceptable when measured need arises, and the lead tells the user before upgrading the plan or raising
  the standing spend. A short, announced freeze while the topology changes is acceptable; losing committed
  state is not.
- **Permission to set everything up is granted**: creating the Railway project `fable-space-program` and its
  services, a dedicated Modal environment `fsp` (existing Modal apps stay untouched), deploy pipelines from
  the GitHub repository, and the R&D spend for load-test rehearsals on Modal. Credentials stay out of
  GitHub and the client.
- Load tests still have to report measured limits honestly. A rehearsal that needs more than the Hobby
  plan allows is run only after the lead has told the user what it will cost.

The other defaults in OPEN_QUESTIONS_V2.md stand (sensor-camera view for craft without a cabin, second site
in Oman with fallback, quick-comms only).

## Local end-to-end runs, scale to zero, alerts (2026-11-11, later message)

Verbatim: "Ideally we can also run locally for e2e testing or we have some sort of scale to zero on the
hosting side esp when not in use. No need for alerts rn"

- **The whole game must run locally, end to end, with no cloud resource**: server roles, persistence, tile
  delivery and several browser clients on this machine, started by one command, used for the multi-client
  acceptance tests and for everyday development. The deployed environment is then needed only for the
  deployed proofs (deploy, restart recovery on production, measured hosting numbers), not for building or
  testing features.
- **Hosting should cost close to nothing when nobody is playing**: design scale to zero (or the nearest
  thing the Hobby plan offers) into the smallest stage - the universe is persistent but an empty one needs
  no CPU - and state the wake-up time a first visitor sees and what, if anything, must still run on a
  timer. If true scale to zero is impossible for a component, say what its idle floor costs.
- **No alerts for now**: do not build alert routing or ask for a webhook; keep the metrics and logs that the
  capacity report needs. Alerting is a later seam.

Facts about this machine for the local stack: Docker Desktop 29.6 is installed but its daemon is not running
(WSL 2 with an Ubuntu distribution exists, stopped); no native Postgres is installed. The machine once
crashed under heavy combined load, and a Docker Desktop VM takes memory from the browser tests and bakes.
Prefer a local stack that runs as plain Node processes with an embedded or file-backed Postgres-compatible
store by default (so agents and the user can run it without starting Docker), and keep the pinned Linux
image through docker compose for the checks that need the production build (bit-exact replay, the image
itself). Say which tests need which.
