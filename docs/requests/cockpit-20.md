Status: open
From: cockpit
Owner path: src/render/atmosphere/** (the cloud layer and the Earth's surface as seen from low orbit); package atmosphere-clouds
Blocking: no   (the cockpit's photo lens: the round-5 critic's verdict on the two hero pictures, relayed by the lead in round 6)

## Problem
From the crew's couch in low orbit the Earth in the cabin windows reads as a flat blue card with popcorn on it:
one even blue, sprinkled with small white blobs of about one size with hard edges. There are no cloud
systems (fronts, streets, cells of different scale), no thin cloud, no soft edges, and little difference
between ocean and land. The cockpit frames the world through its windows; what is in the panes is the
atmosphere package's picture, and it is now the weakest part of the view the player has from the default
seat (the pilot's centre couch, request cockpit-18).

## Evidence
Both pictures are written by `tests/browser/cockpit/world.spec.ts` (real world, real sim, 1600 x 900):

- `out/screens/cockpit/world-leo-pilot-seat.png`: the player's first view (centre couch, rest pitch 20
  degrees, 200 km orbit, `scene=lowOrbit&roll=180`). Both forward windows: a uniform blue field with some
  forty white blobs each, all of the same character.
- `out/screens/cockpit/world-leo-earth-side-window.png`: the head near the side window, looking down. Dark
  blue-green ground, the same blobs, each a hard-edged white patch without shading or shadow on the ground.

The same from outside the cabin: `out/screens/cockpit/world-chase-window-sun.png` (upper left).
Reference the critic used: apollo7-schirra-inflight.jpg ("the Earth in the window is blue and white with
cloud detail") and any ISS cupola photograph: cloud at several scales, soft-edged, with its shadow.

## Requested change
The cloud field as seen from 200 to 400 km: structure at several scales (systems of hundreds of kilometres
down to cells of a few), soft and thin cloud as well as dense, cloud shadows on the surface, and the
surface's own contrast (ocean, land, sun glint) under it. Nothing is asked of the cockpit's interfaces; the
cockpit's pictures above will show the result as they are.

## Acceptance
In the two pictures above the panes show cloud systems of more than one scale with soft edges, and ocean
and land can be told apart; no pane reads as a single flat colour with dots.
