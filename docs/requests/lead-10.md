Status: open
From: the lead (contract owner), for island-core's request island-core-2
Owner path: src/core/contracts/net.ts, the wire section (`WireCommand`), and src/net (wire-protocol)
Blocking: no (the island takes the reference as an input of its own, `IslandInput` `kind: 'reference'`; a
network session cannot send it yet)

## Problem
1. The velocity that a pilot's prograde / normal / radial SAS hold refers to (the surface's or the orbit's)
   changes the held direction and so the flight. v1 took it from the navball mode, which the pilot sets
   (`PlayerCommands.setNavballMode`) and which switches by altitude. In the island it is the seat's state
   and arrives as an input at a tick. The wire has no message for it: `WireControlState` and `InputSample`
   carry `sasHold` only for the maneuver and target modes.
2. The rules document (message 61) gained nine numbers on 2026-11-24, as members of its existing groups:
   `pads.meanCycle`; `claim.armedTestInterval`, `.reachAcceleration`, `.referenceOffsetMax`;
   `time.watchTemperatureFraction`, `.watchJointFraction`, `.watchGroundTime`, `.reducedStep`,
   `.coastTimeToRails`. The lead added them to `universeRules` in `src/net/codec/common.ts` as plain `f64`
   fields (the struct refuses to compile without them), which lengthens the message by 72 bytes. No
   protocol version step was made and no recorded file of the wire layer changed (src/net and
   tests/unit/net pass: no fixture or transcript holds a rules document).

## Requested change
1. A command of the wire section, sent like every other command (reliable, acknowledged, applied at its
   stamped tick):
   ```ts
   | { kind: 'velocityReference'; reference: 'surface' | 'orbit' }
   ```
   in `WireCommand`, with its codec, its place in the per-type limits (it is a command: `commandsPerSecond`)
   and a case in the session's command path that hands it to the universe as the island's
   `{ kind: 'reference' }` input. (A bit of `InputSample` would also carry it; a command is preferred
   because the reference changes a few times in a flight and must not be lost with a superseded sample.)
2. Say whether the longer rules document is a layout change that wants `WIRE_PROTOCOL_VERSION` 3 (a client
   and a server of one build always agree, and the Hello refuses another build), or stays within version 2
   as an addition; and re-record whatever of yours holds a rules document if something does.
