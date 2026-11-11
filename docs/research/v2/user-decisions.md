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
