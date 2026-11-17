Status: open
From: wire-protocol
Owner path: package.json, package-lock.json (lead: root configuration)
Blocking: no

## Problem
The brief of `wire-protocol` lists under PROVIDED BY THE LEAD "ws and its types, fflate", and MIGRATION_V2
(lead step "before 4.1") says the lead installs wave 4's dependencies `ws` and its types and `fflate`. None of
the three is in `package.json` or `node_modules` on 2026-11-16.

## Evidence
`node -e "console.log(Object.keys(require('./package.json').dependencies), Object.keys(require('./package.json').devDependencies))"`
lists neither `ws`, `@types/ws` nor `fflate`; `ls node_modules/ws node_modules/fflate node_modules/@types/ws` reports
"No such file or directory" for each.

## Requested change
Install, as the lead step "before 4.1" planned:
- `ws` (dependency; server/ and bots/ are the only importers the boundary test allows) and `@types/ws`
  (devDependency);
- `fflate` (dependency): the application deflates the island-codec blob that `IslandEnter` carries
  (ARCHITECTURE 13.3; server-persistence on the shard side, netcode-client on the client side).

What `wire-protocol` does meanwhile, inside its own paths (no workaround copies foreign code):
- `src/net` imports neither package (the boundary test forbids `ws` there, and the codec carries the island
  blob opaque with its encoding named, so it needs no deflate). The Node `ws` transport adapts any object
  with the `ws` socket's interface, structurally typed in `src/net/transport/websocket.ts` (`nodeWsTransport`).
- The tests of the browser WebSocket transport run against a small RFC 6455 server written for the tests
  (`tests/unit/net/helpers/miniWsServer.ts`, node:http + node:crypto), in Node (Node 24's own WebSocket
  client) and in Chrome. The test of the Node `ws` adapter against a real `ws` server is the one test that
  waits for this request; it is listed as such in `docs/handoff/wire-protocol.md`.

Nothing else must change: no other dependency, no configuration entry.
