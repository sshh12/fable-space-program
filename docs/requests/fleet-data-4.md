Status: open
From: fleet-data
Owner path: src/core/contracts/net.ts (`DEFAULT_PAD_CLASS_LIMITS`, `UniverseRules.pads.classLimits`), the default rules document (the lead)
Blocking: no (validateVehicle reports the Solstice stacks as over the medium diameter until the limits are set)

## Problem
The class limits of pads are provisional and set from fleet-data's table (lead note of 2026-11-12). Under the
provisional defaults (medium 7 m) the three Solstice vehicles are reported `padClassExceeded`: their core is 6.6 m,
but the M-3's two RCS pods (existing part `meridian-m3-rcs-pod`, on the hull at 3.45 m, radius 0.55 m) make the
stack 8.00 m across, as on the lunar stack's M-3.

## Evidence
`analyzeVehicle` (src/sim/vessel/analyze.ts; tests/unit/fleet/analyze.test.ts), largest diameter = the widest part
envelope about the stack axis, clamps excluded:

| Vehicle | Class | Lift-off mass | Diameter | Widest part |
|---|---|---|---|---|
| azimuth-pathfinder | light | 60.54 t | 2.20 m | the 2.2 m stages and fairing |
| solstice-kestrel | medium | 600.95 t | 8.00 m | M-3 RCS pods |
| solstice-atoll | medium | 610.50 t | 8.00 m | M-3 RCS pods |
| solstice-pelican | medium | 611.30 t | 8.00 m | M-3 RCS pods |
| meridian-lunar | heavy | 2,756.10 t | 9.50 m | M-1 retro motor ring (r 4.75 m) |
| meridian-egret | heavy | 2,747.50 t | 9.50 m | M-1 retro motor ring |
| meridian-albatross | heavy | 2,745.00 t | 9.50 m | M-1 retro motor ring |
| meridian-pelican-heavy | heavy | 2,756.40 t | 9.50 m | M-1 retro motor ring |

`tests/unit/fleet/validate.test.ts` ("under the provisional defaults ...") holds the three findings.

## Requested change
Set `UniverseRules.pads.classLimits` (and `DEFAULT_PAD_CLASS_LIMITS`) to:
- light: 70 t and 2.5 m (as now; the heaviest light vehicle is 60.5 t, 15.6 % headroom; 2.2 m wide);
- medium: 700 t and **8.5 m** (heaviest 611.3 t, 14.5 % headroom; 8.0 m wide, 0.5 m headroom);
- heavy: 3,000 t and **9.56 m**, the opening of LC-1's own launch mount: the heavy stacks are 9.50 m with the
  M-1's retro-motor ring, so the opening, not a rounder number under it, is the limit that means something
  (heaviest 2,756.4 t, 8.8 % headroom).
LC-1 then need not state its own values (they equal the class's at 3,000 t; its 9.5 m would stay an override
narrower than the class: drop it, or keep it at 9.56). With these limits `validateVehicle` reports nothing for
the eight vehicles (the test's PROPOSED document). Must NOT change: any pad's position, disc or mount height.

## Launches per hour per class (ARCHITECTURE 5.9, 9.3; cycle 150 s, 24 launches per pad-hour)
Pads by class from the site files: Ka Lae 2 heavy (LC-1, lc-2), 2 medium, 5 light; Madrakah 4 heavy, 6 medium,
6 light; 25 in all.

| Vehicle class | Pads it may use | Launches per hour | Vehicles of the fleet |
|---|---|---|---|
| heavy | 6 (heavy) | 144 | meridian-lunar, meridian-egret, meridian-albatross, meridian-pelican-heavy |
| medium | 14 (medium + heavy) | 336 | solstice-kestrel, solstice-atoll, solstice-pelican |
| light | 25 (all) | 600 | azimuth-pathfinder |

Class mix proposed for a new player (`firstOffer` in data/defs/visuals/vehicles/<id>.json, menu text): the light
and the three medium vehicles are offered first, so a new player's choices draw on 14 to 25 pads (336 to 600 an
hour), and the four heavy vehicles are offered from the hangar with their queue shown. The cost: the original
mission's stack (meridian-lunar) is heavy and is not in the first offer, and every heavy launch shares 6 pads
(144 an hour); heavy demand above that queues whatever the mix.
