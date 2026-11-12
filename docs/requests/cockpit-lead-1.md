Status: resolved (commit 98a286b and the round-3 commits after it)
From: lead (user report, 2026-11-11, from playing the integrated build)
Owner path: src/render/cockpit/** (cabin geometry: console, couches, fixtures, apertures) and data/defs/visuals/cockpits/**
Blocking: no

## Problem
The cockpit's polygons overlap in visible, odd ways: the instrument console (the dash) runs into the side of the
craft - it penetrates the cabin's inner hull wall instead of ending against it. The visual critiques had already found
related interpenetration (seat parts poking through or past one another, harness straps cutting through the cushions:
docs/qa/wave2/cockpit*.json), but not the console against the hull, which the user saw first.

## Evidence
User report while playing the app (`npm run dev`, then C for the cockpit view, looking left and right along the
console). Pictures to compare: out/screens/cockpit/ and out/screens/mission/*-cockpit.png.

## Requested change
Make the cabin geometrically consistent: no part of the console, couches, panels, lockers, harnesses or fixtures
crosses the inner pressure-hull surface or another part. Fit the console's ends to the hull's curvature (a closure
panel or a fillet against the wall, as real capsules do), and add an automated check: sample every interior part's
triangles against the hull's inner surface (signed distance from the conical / cylindrical frustum the cabin is
built from) and against each other, and fail on any penetration deeper than a few millimetres. Re-shoot the cockpit
views looking along the console to both sides and LOOK at them.

## Resolution
The check came first and found the cabin far worse than the report: 123 pairs of assemblies deeper than 3 mm into
each other, into the hull or into what lies on it (two of the six floods inside the console's body, two more
above its skirt where the cabin never saw them; cables and handholds through the console; the couches' outboard
hips in the blankets; struts through the pallet beams; every wall fixture sunk into the insulation or a ring
frame; lockers and ducts through the floor). All of it is fixed; the check now passes with nothing found.

- **The check** (`src/render/cockpit/penetration.ts`, `tests/unit/cockpit/penetration.test.ts`, runs in vitest in
  about 2 s): every vertex belongs to a named assembly (`MeshBuilder.group`). The pressure wall and the floor are
  tested analytically against the shared mould line (signed distance minus the wall thickness); blankets, ring
  frames, stringers and close-out panels as skins (a point is under a skin when the ray along the wall's inward
  normal meets it); every other assembly as a solid (a point is inside when the first surface met in at least
  12 of 14 directions is seen from behind). Every vertex and, for triangles over 3 cm, centroid and edge
  mid-points of the full detail level are sampled; anything deeper than 3 mm fails, with the pair, the depth and
  the place. Mounting hardware that reaches through the insulation to the structure (stand-offs, feet, strap
  ends, clamps, the console's seal and brackets) is built as `mount:*` assemblies: exempt from the skins, but no
  vertex of anything, mounts included, may lie in the wall or under the floor (all three detail levels).
  `COCKPIT_PENETRATION_REPORT=1 npx vitest run tests/unit/cockpit/penetration.test.ts` prints the list.
- **The console** (`cabin/console.ts`): each section's face plate is limited row by row to the half-width the
  hull leaves at that height (bisection on the mould line), so its hull-side edge IS the wall's curve at a
  constant stand-off (blanket crowns + 12 mm), with a rubber seal bead along it; the body behind stands clear of
  the ring frames (frame height + 4 mm) and follows the wall back as the cone narrows; two brackets per side to
  the structure. The layout was moved inside the hull (sections +-0.77, displays +-0.415, attitude indicator
  -0.655, lamps and master alarms inboard); a layout whose instrument hangs over the panel's hull-side edge is
  now refused at build time with the part's name. Console depth 0.32 m (it was 0.6 and swallowed two floods).
- **Couches**: outboard couches 34 cm wide at the back, their leg troughs turned inboard from the hip, shins
  5 cm shorter (the foot end stood in the aft blankets); attenuator struts stand under the pallet beams; the
  inboard arm rests of the outboard couches sit over the bolster; the harness is laid on the pads as built (a
  ray onto the couch's own triangles), belts start on the back cushion.
- **Fixtures** (`cabin/fixtures.ts`, places now in the layout's `fixtures`): every body stands clear of the
  blankets / frames / close-outs under it (`skinHeight`) and of the floor; relocated where they collided (floods,
  handholds, cables, bags, pouch, checklist, ducts round the pallet's wall fittings).
- Pictures along the console to both sides, in the app: `out/screens/cockpit/app-leo-console-left.png`,
  `app-leo-console-right.png` (`tests/browser/cockpit/app.spec.ts`).
