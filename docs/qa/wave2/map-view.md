# map-view: merged visual QA work list (wave 2)

**Verdict.** Not ready: photo lens 4, artifact lens 4.5 (25 screenshots each). The line drawing itself is clean and the real orbits are hidden correctly behind bodies, but one rendering bug draws a false straight line across the frame and over the planet, the node-editing flow shows three defects in the package's own acceptance pictures (tooltip under the panel, selected gizmo dimmed, handles stacked on one axis), surface rings tear near the limb, icons and labels collide at overview zoom, and the overlay has never been shown over the real planet or in the HUD's type. This list merges 24 critic findings (13 photo, 11 artifact) into 19 items: 1 blocker, 8 major, 10 minor, ordered by how much a player would notice. I opened all 25 screenshots plus zoomed crops; every item is visible in the cited picture and none was dropped. Where part of a claim cannot be seen in a still (frequency over camera angles, motion, behaviour over the real renderer), the item says so.

Paths are relative to `C:\dev\fable-space-game`. Screenshots are in `out/screens/map-view/` (1280x720, coordinates in px). They were taken 2026-11-10 22:18, after the last `src/map` commit (17:17), and `src/map` has no uncommitted changes, so they show the current code. Line numbers below were checked against the current files.

Shared fixes: items 5 and 12 (zone rings); items 6, 7 and 10 (draw list and `labels.ts`); items 2, 15 and 16 (node panel); items 8 and 9 need the integration lab and flight-ui.

---

## 1. A false straight line crosses the frame and the face of the planet

- **Severity:** blocker (photo)
- **Screenshots:** `accept-occlusion.png`: straight periwinkle line from about (0,437) to (1150,0), drawn over the lit Earth from about (524,237) to (645,192).
- **Checked:** visible. Two parallel lines in the Moon-orbit colour; the lower one (the real orbit) stops at the limb on both sides, the upper one runs unbroken over the disc.
- **Defect:** A second line in the Moon-orbit colour lies 10-27 px above the real Moon orbit and is drawn over the planet it should be behind. It is perfectly straight (slope -0.385) while the real orbit curves. It is one chord of the Moon-orbit polyline whose far end lies behind the camera, mirrored through the screen. The photo critic reproduced it headlessly (scene builder plus float32 emulation of the vertex shader): the chord from the vertex at depth 32,200 km to the next at depth -112,300 km clips to a depth of -2 m / -8 m instead of +0.05 m, so its end lands at (+1.4e11, -5.2e10) px. From that reproduction, not from a still: about 40 % of 720 camera orientations at 24,000 km show such a line; in the translunar scene about 40 % of views get one in the colour of the active trajectory (2.5 px, bright cyan); in lunar orbit the Moon orbit and the SOI circle do the same; and because the sign of the rounding error changes with the view, the line will pop in and out while the camera rotates. Not determined: `accept-recovery-zones.png` has one straight line in the same colour from (0,287) to (1000,0) that never meets the disc; check whether it is the real orbit or the mirrored chord.
- **Real reference:** In KSP, Juno or any shipped orbital map an orbit that wraps around the camera is cut at the screen edge. No line crosses the face of the planet it is behind, and nothing flashes on and off with camera yaw.
- **Likely cause:** `src/map/gpu/shaders.ts` lines 106-124, the near-plane clip in `vsLine`: `pb = mix(pb, pa, t)` with `t = (near - wb0) / (wa0 - wb0)`, near = `NEAR_PLANE` = 0.05 m (`src/core/contracts/render.ts`), while `pa`/`pb` are float32 view-space metres of order 1e8. Float32 rounding there is 8-16 m, hundreds of times the near distance, so the clipped point ends up behind the eye about a third of the time and `toScreen()` divides by a negative w. `src/map/sampler.ts` leaves off-frustum pieces as single chords of 22.5 / 45 degrees of orbit, so every orbit larger than the camera distance has two chords that straddle the camera plane. The static-camera jitter specs cannot catch this.
- **Fix direction:** Clip at the camera plane in float64 on the CPU: in `scene.ts` `addCurve` (or the sampler's emit), when consecutive vertices straddle the near plane, end the polyline there (flag bit 0 off) if the front vertex is off screen, otherwise insert the f64 intersection at a depth that survives float32. Or make the shader clip robust: clip to `max(near, ~4e-6 * max(length(pa), length(pb)))` and drop the instance when the clipped w is still <= 0. Add a test that rotates the camera through 360 degrees around the Earth at 2.4e7 m in the lowOrbit and translunar scenes and asserts that no drawn segment has an end with w <= 0 and that no Moon-orbit-coloured pixel lies inside the Earth's disc.

## 2. The hover tooltip collides with the node panel, the gizmo and neighbouring labels

- **Severity:** major (both lenses)
- **Screenshots:** `accept-node-added.png` (tooltip x 485-560, y 497-597, running under the panel at x 558-790); `hover-impact-details.png` (tooltip x 669-982, y 380-464).
- **Checked:** visible in both. The tooltip reads "Maneuver n", "Prograde 0." where the panel cuts it, and the rest of its text ghosts through the panel.
- **Defect:** (a) Right after the most basic action (click the orbit to add a node, pointer still on the node) the canvas tooltip "Maneuver node / Prograde / Normal / Radial / Total / In" is cut off by the DOM panel above the canvas, its values show through the 94 % opaque panel beside the panel's own Prograde / Normal / Radial rows, and the tooltip box covers the prograde handle at (498,527), the control the player wants next. It only repeats what the panel shows. With panel offset (+92, +28) and tooltip offset (+18, +18) the overlap happens on every hover of a selected node. (b) In `hover-impact-details.png` the tooltip slices through two labels: "T-3d 19h 26" loses its last character and the lower half of "T-3d 14h 56m" is covered by the tooltip's top edge.
- **Real reference:** A shipped interface shows one source for a value at a time: no tooltip for the object whose editor is open, tooltips flipped into free space, and labels under a tooltip hidden whole, not cut through glyphs.
- **Likely cause:** `src/map/controller.ts` lines 875-890: the tooltip is placed at pointer + 18 px and flipped only at the viewport edges; it is not part of `declutter()` (line 867) and ignores `this.blocked` (the panel rectangle, lines 857-866) and the handle positions. `tooltipLines()` (line 909) returns the node tooltip even when the node is selected. Labels are emitted before the tooltip rectangle is known. The panel background is `rgba(10, 15, 22, 0.94)` (`src/map/panel.ts` line 16).
- **Fix direction:** Show no node or handle tooltip while that node is selected (move the "Shift fine, Ctrl coarse" hint into the panel). For other tooltips choose the quadrant that intersects neither the panel rectangle nor a handle of the selected gizmo, then pass the tooltip rectangle to `declutter()` as a blocked rectangle so covered labels are hidden whole. Make the panel background opaque (item 16). Add a browser check that the bounding boxes of tooltip, panel and handles are pairwise disjoint after adding a node.

## 3. The gizmo of the selected node is drawn at a third strength when the node is behind the limb

- **Severity:** major (both lenses)
- **Screenshots:** `lowOrbit-node.png` (gizmo x 740-840, y 175-270, node at (790,224); label x 828-962, y 209-238).
- **Checked:** visible. Handles are murky olive, plum and teal, the label is grey, while the panel beside it is open and editable.
- **Defect:** In the hand-off's own "gizmo + panel" picture the node being edited looks disabled. Its six handles, the node disc and the label "Node 1  Δv 426.1 m/s / T-25m 00s" are drawn at 35 % alpha (normal handle peaks at RGB 80,33,88 against 207,84,223 undimmed, about 1.7:1 against the background; label peak 82,86,90), and the handle arms are close to invisible and run across the planet disc. The node merely sits just behind the Earth's limb. The hand-off lists the alpha floor as a known limit, but it is plainly visible.
- **Real reference:** In KSP and in every DCC manipulator the active gizmo is an interface control: always on top at full brightness. That the node is behind the body is shown on the node icon alone (hollow or dashed ring); only unselected nodes fade.
- **Likely cause:** `src/map/controller.ts` line 820: `const a = Math.max(0.35, 1 - n.hidden)` is applied to the selected node's handles (line 837), arms (`0.55 * a`, line 833, 1.5 px wide), disc (line 840) and label (line 842). `isSel` is already known at line 823.
- **Fix direction:** For the selected node use alpha 1 for disc, handles, arms and label regardless of `n.hidden`; signal "behind the body" with a hollow or dashed-ring variant of `ICON.node`. Keep the 0.35 floor for unselected nodes only. Raise the arms to 2 px and at least 0.8 alpha so they also hold over a lit planet (`accept-panel.png`). Add a pixel assertion to the lowOrbit node spec that a handle of a selected, occluded node reaches its full colour.

## 4. Seen from above the orbit, the normal handles sit on the radial axis

- **Severity:** major (artifact)
- **Screenshots:** `accept-node-added.png` and `accept-prograde-drag.png` (node at (465,479)); `accept-panel.png` (node at (777,200)).
- **Checked:** visible in all three. Both magenta triangles are threaded on the cyan radial bar between the node and the cyan handles.
- **Defect:** In the top-down view of the orbit (the default way to look at it) the normal and antinormal handles lie exactly on the radial axis: the magenta normal bar is drawn collinear on top of the cyan radial bar (a purple-cyan mixed line), and four handles and two bars share one screen line within 22-58 px of the node. Normal cannot be told from radial, and the nearer normal triangles are likely to take the click meant for radial (inferred, not tested). In `accept-panel.png` the retrograde handle also lands on the Pe marker and the vessel icon. The brief asks for an uncluttered gizmo.
- **Real reference:** A translate gizmo seen down one of its axes shows that axis as a distinct toward/away glyph beside the pivot, or fans it out to a fixed screen offset; two axes are never drawn on one screen line. KSP's node gizmo keeps its six handles apart at any camera angle.
- **Likely cause:** `src/map/scene.ts` `axisScreen()` lines 661-672: the handle's screen direction is the derivative of the perspective projection. For an axis along the view direction that derivative is (p.x, -p.y) / depth^2, the direction from the screen centre to the node, which with the planet centred is the radial direction. `src/map/controller.ts` line 485 then still draws it at `HANDLE_MIN_FORESHORTEN` (0.38) x 58 px = 22 px along that degenerate direction.
- **Fix direction:** When an axis' extent falls under about 0.4, stop using the projected direction: rotate it to a fixed screen offset perpendicular to the best in-plane axis (blend with extent so it does not pop), or draw the pair as toward/away glyphs at fixed offsets. Enforce a minimum angular separation of about 25 degrees between any two axis directions. Add a unit test over view directions asserting that handle centres are at least one handle diameter apart and no handle lies on another axis' bar.

## 5. Recovery-zone rings tear into dashes near the limb

- **Severity:** major (both lenses)
- **Screenshots:** `scene-lowOrbit.png` (Central Pacific ring, x 440-560, y 430-560); same view in `lowOrbit-node.png` and `hover-add-maneuver.png`; `accept-occlusion.png` (Central Atlantic ellipse x 770-803, y 380-450: notch with a spur at the top tip, dimmed stretch at the bottom tip; gap in the Central Pacific ring beside the pad icon); `synthetic-earth.png` (zones on the dark limb near (690,340) and (620-660,412) are broken green blobs).
- **Checked:** visible. At 6x the Central Pacific ring in `scene-lowOrbit.png` has a gap at the top left, three on the inner right side, one at the bottom hook and a stray tick.
- **Defect:** The rings are solid lines lying on the body, but toward the limb the middle of each chord vanishes and only the stretches near the vertices remain, so the ring looks torn, like z-fighting between line and surface. Photo critic's probe of the default lowOrbit view with the shader's occlusion function: 20 of 307 px of near-side chords of zone 0 and 21 of 123 px of zone 1 are classified hidden (chords (558,544)-(553,530), (476,455)-(461,448), (606,569)-(561,554) and others, matching the gaps). The breakup starts about 64 degrees from the sub-camera point (outer 10 % of the disc radius) and worsens to the limb.
- **Real reference:** A circle drawn on a globe is one continuous stroke up to the limb, where it foreshortens into the edge and is cut exactly where it goes behind the planet (KSP and Orbiter ground markers, any GIS globe).
- **Likely cause:** `src/map/scene.ts` `addZoneLine` (lines 1057-1066) sets `occlusionSlack` to the radial depth of the deepest chord midpoint below the sphere (+1e-3 R; 11-43 km here). `src/map/gpu/shaders.ts` `occlusion()` line 45, `if (tp <= t1 + tol + slack) { continue; }`, applies that slack as a distance along the view ray. A point at radial depth s under the surface, seen at incidence angle phi, lies s / cos(phi) along the ray inside the sphere, which is unbounded at the limb, so mid-chord fragments are judged hidden while fragments at the vertices survive. Zones are sampled as "faint" lines (`scene.ts` line 725, `FAINT_CHORD_TOLERANCE_PX` = 0.9), which gives only 16-23 vertices and a chord sag of about 10 km.
- **Fix direction:** Keep the chords out of the sphere instead of forgiving them: sample the zone circle on a slightly larger sphere (vertices lifted to R / cos(half step), or R + worst sagitta) and drop the slack. Or make the slack radial: for lines that carry a slack, test against a sphere of radius R - slack (`t1` from R - slack; not occluded when `dperp >= R - slack`), and mirror it in `src/map/occlusion.ts` if zone outlines are ever tested on the CPU. Sample zone rings at `CHORD_TOLERANCE_PX` (item 12). Add a browser spec with a zone centred 75-88 degrees from the sub-camera point that walks the projected circle and asserts no gap pixels on the visible side.

## 6. Icons pile up, bury the body they surround, and displaced labels have no leader

- **Severity:** major (both lenses)
- **Screenshots:** `synthetic-8-patches.png` (Earth cluster x 600-660, y 340-380; Moon cluster x 380-460, y 385-460); `scene-synthetic.png` and `synthetic-chain.png` (Earth at (642,357); Moon cluster at (410-430,415)); `scene-synthetic-intercept.png` (Ap ring under the AN diamond at (518-524,568)); `accept-zoom-1e9m.png` ((630-640,361)); `hover-impact-details.png` (two red crosses at (648,358) and (646,366)).
- **Checked:** visible. At 9x the Earth in `synthetic-8-patches.png` is hidden under three overlapping node discs and debris ellipses; at 10x the impact marker is a circled cross with a bare cross 8 px below it; at 12x the Ap and Pe rings at 1e9 m form a figure-eight.
- **Defect:** At the Earth-Moon overview the Earth (about 9 px) is covered by Node 2's 16 px disc, the entry marker and debris ellipses. Nodes 2, 3 and 4, Relay 1 and Kestrel are stacked on one spot with five labels standing 20-40 px away and nothing tying a label to a disc. At the Moon the Pe ring, the impact icon (only a red arc is left), Node 1 and the Moon icon are stacked, with "Exit Moon", "Moon", "Impact ... miss 22.7 km", "Pe 2912 km" and "Node 1" around them. Displaced labels ("Ap 425.9 Mm", "Closest 162.6 Mm", "Exit Moon") have no leader. The impact marker and its ground-point twin are drawn as a double red icon. At 1e9 m the Ap, Pe and vessel icons of a 200 km orbit pile onto an invisible Earth with three labels.
- **Real reference:** KSP, Orbiter, the Elite orrery: coincident markers collapse into one icon or badge that fans out on hover, a label moved away from its marker gets a thin leader line, apsis markers are not shown for an orbit a few pixels across, and a marker never hides the planet it orbits.
- **Likely cause:** No clustering: every marker is drawn at `MARKER_RADIUS_PX` 6.5 / `NODE_RADIUS_PX` 8 at its exact point regardless of the on-screen size of its patch (`src/map/controller.ts` lines 808-843); the `/surface` twin is always added (`src/map/scene.ts` line 484); labels carry no leader (`controller.ts` lines 868-873).
- **Fix direction:** Merge icons closer than about 10-12 px: draw the highest-priority one with a count badge and a combined tooltip, or fan them out radially with leaders to the true point. Draw a 1 px leader (label colour, half alpha) whenever a placed label is more than about 14 px from its anchor. Skip the surface-point marker while it is within about 12 px of its parent marker. Suppress apsis and node-line markers when their patch spans less than about 40 px. Shrink unselected node discs to about 5 px so a node at perigee does not cover a 9 px planet.

## 7. Labels are struck through by lines, and avoid nothing except the node panel

- **Severity:** major (both lenses)
- **Screenshots:** `scene-lunarOrbit.png` ("Fake vessel" and "Pe 100.0 km", x 570-750, y 540-560); `scene-translunar.png` and `accept-translunar.png` ("T-4d 15h 12m" under Ap, x 587-667, y 460); `hover-impact-details.png` and `synthetic-moon.png` ("Impact 4.84°S 57.61°W  miss 22.7 km", x 403-634, y 352); `synthetic-chain.png` ("Pe 2912 km / T-3d 19h 26m", x 375-455, y 441-456); `scene-synthetic-intercept.png` ("Node 1  Δv 407.4 m/s", x 521-652, y 511); `accept-recovery-zones.png` (zone rings through "Ka Lae Pacific Spaceport" near (705,284) and "Central Pacific" near (734,359)); `synthetic-earth.png` (label "Closest 358.2 Mm / T-8d 08h 49m" at (339-445, 677-692) on top of the lab's status text).
- **Checked:** visible in each.
- **Defect:** (a) The vessel's own trajectory runs through the words "Fake vessel" and "Pe 100.0 km"; the cyan orbit crosses the Ap label's time line; the dashed planned patch runs between "W" and "miss" of the impact label; the Moon's SOI circle and orbit line cut through the Pe label; trajectory and dashed lines cross "Node 1"; zone rings cross the names of the pad and of a zone. The 1.5 px dark halo does not separate text from a 2.5 px bright line. (b) A label is placed over the lab's status line at the bottom edge, which shows that labels avoid only the node panel and will also run under the HUD panels.
- **Real reference:** Map labels in shipped games sit on a plate that masks what is behind them, or are placed off the line on its outer side with a short leader. Text is never crossed by a trajectory stroke and never overlaps other interface panels.
- **Likely cause:** `src/map/labels.ts` `declutter()` (from line 162) tests candidates only against icons, earlier labels and blocked rectangles; polylines are not obstacles, and candidate 0 (right of the anchor, vertically centred) is taken whenever free, which for a vessel or apsis marker is usually along its own orbit. Labels have no backing, only the glyph halo (`src/map/gpu/glyphAtlas.ts` line 60, `lineWidth = 3 * pxScale`). The controller passes a single blocked rectangle, the panel (`controller.ts` lines 857-866).
- **Fix direction:** Either give every label a rounded backing plate (about 75 % black, drawn in the icon layer before the glyphs), or add the screen segments of current / planned patches, body orbits and zone rings (the sampled vertices are already in `scene.verts`) as obstacles with a cost and order the eight candidates by the outward normal of the anchor's own line. Let the app pass further blocked rectangles (the HUD panels) to `update()` / the controller. Add a unit test that no placed label rectangle intersects a current / planned polyline segment when a free candidate exists.

## 8. Weak legibility over a lit body, and the map has never been shown over the real planet

- **Severity:** major (both lenses)
- **Screenshots:** all 25 (backdrop); `accept-recovery-zones.png`, `accept-occlusion.png`, `scene-lowOrbit.png` (labels and lines over the lit Earth); `accept-zoom-200km.png`.
- **Checked:** visible. Every picture shows the lab's untextured sphere on black with a stair-stepped limb; at 6x "Central Pacific" is grey lettering inside a black outline heavier than the letters.
- **Defect:** (a) Surface-target names are drawn in the dim text colour over a heavy dark halo; on the lit Earth they read as grey bubble letters. Measured by the artifact critic: "Central Pacific" glyphs RGB 167,179,196 on 114,124,138 (about 2.0:1), "Ka Lae Pacific Spaceport, Launch Complex 1" about 1.5:1. (b) Lines have no dark edge: the light cyan orbit and the 2 px green rings sit on the light blue sphere at low contrast. (c) Every screenshot shows the lab's untextured Lambert spheres with an un-antialiased limb, which is the "blue gradient / smooth sphere" `PROMPT.txt` forbids. The feature is mounted nowhere else: `createMapView` is called only by `labs/map-view/main.ts`; `labs/integration` does not import `src/map`, and `out/screens/integration/` has no map picture. Predictions, not visible in any screenshot: over a tonemapped Earth with white cloud and a bright atmosphere limb the dim text, green rings and light-blue apsis rings will lose more contrast, and occluders that use the bare `BodyDef.radius` will leave lines visible through the atmosphere glow.
- **Real reference:** The shipped view is the overlay on the game's real Earth and Moon. Orbit lines carry a dark casing or glow that survives over clouds and ocean glint; text on a bright planet is white on a dark plate or has a wide soft shadow (4.5:1 or better); lines end where the visible limb, including atmosphere, ends.
- **Likely cause:** `src/map/controller.ts` lines 775-779: target labels use `COLORS.textDim` (#aab6c8) times the target alpha. `fsLine` in `src/map/gpu/shaders.ts` (line 167) writes coverage only, no casing (`fsIcon` has a halo at lines 386-388). `labs/map-view/backdrop.ts` is the only background the overlay has been judged against.
- **Fix direction:** Draw target names in `COLORS.text` at alpha 1 once shown (dim only a second line). Add a dark casing to `fsLine` (a second, wider coverage ramp writing the halo colour at about half alpha, as `fsIcon` does), at least where the fragment lies over a body disc. Mount the map view in the integration lab over the real renderer and add a screenshot spec: Earth day side with cloud, the limb, the terminator, the night side, the real Moon and the translunar overview; then tune colours, halo and an occluder radius extended by the visible atmosphere height. Note: `labs/integration/main.ts` has uncommitted changes from other work in the tree; do not overwrite them. Until those pictures exist, treat legibility over lit bodies as unproven.

## 9. The map uses a different typeface and panel style from the HUD, and adds a second maneuver panel

- **Severity:** major (photo)
- **Screenshots:** `lowOrbit-node.png`, `accept-panel.png`, `synthetic-earth.png`, `synthetic-moon.png` (node panel and every label); compare `out/screens/flight-ui/map-lowOrbit-720p.png`.
- **Checked:** visible. The flight-ui picture has DIN-style type, tracked uppercase captions and a MANEUVER panel (bottom right); the map pictures are 12 px monospace throughout.
- **Defect:** Every map label is 12 px Consolas rasterised from a canvas, and the node editor is a Consolas form with plain bordered inputs and text buttons ("-1 orbit", "+1 orbit", "Delete"). The flight HUD that shares the screen uses Bahnschrift / DIN with tracked uppercase captions, tabular figures and its own panel chrome, and already has a MANEUVER panel. Side by side the map reads as a developer overlay, and the player gets two maneuver panels in two styles.
- **Real reference:** KSP 2, Juno: New Origins, Elite Dangerous: one type family and one panel component across HUD and map; captions in small tracked capitals, tabular numerals, the node editor built from the HUD's panel with the six axis glyphs as icon buttons.
- **Likely cause:** `src/map/gpu/glyphAtlas.ts` line 10, `FONT_FAMILY = "Consolas, ..."` (one monospace advance for every glyph; the draw list and `labels.ts` measure text as chars x advance, e.g. `controller.ts` line 880); `src/map/panel.ts` line 17, `font: 12px/1.35 Consolas`, and hard-coded colours; nothing shared with `src/ui/hud/hudStyles.ts` line 27 (`Bahnschrift, 'DIN Alternate', 'Segoe UI'`).
- **Fix direction:** Move the HUD's type and colour tokens somewhere `src/map` may import (`src/core`), or file a request to flight-ui for them. Rasterise the atlas in the HUD family with per-glyph advances (store the advance per cell, measure labels by summing advances, keep digits tabular). Restyle the panel from the HUD tokens: uppercase tracked captions, the handle glyph beside each of Prograde / Normal / Radial, icon buttons. Agree with flight-ui which of the two maneuver panels owns which numbers.

## 10. The body the view is centred on has no name

- **Severity:** minor (photo; the artifact critic counted it inside its major pile-up finding, item 6)
- **Screenshots:** `scene-translunar.png` and `accept-translunar.png` (Earth at (640,360)); `accept-zoom-1e9m.png` (centre); `synthetic-8-patches.png`, `scene-synthetic.png` (Earth at (642,357)); `synthetic-moon.png` and `hover-impact-details.png` (Moon at (637,365)).
- **Checked:** visible. The Moon is labelled in the overviews, the Earth is not.
- **Defect:** In the Earth-Moon overview the Earth is an unlabelled 8-9 px dot; at 1e9 m it disappears under the Ap / Pe / vessel icons; in the Moon close-up the Moon is a 19 px grey blob with two red icons on it and no label. With icons stacked on it (item 6) the home planet cannot be found.
- **Real reference:** Orbital maps name every body that is too small to recognise, the central one first, and keep the name at overview zoom.
- **Likely cause:** `src/map/constants.ts` line 49, `SMALL_OBJECT_PX = 6`, and `src/map/controller.ts` lines 782-791: a body gets an icon and a label only while its projected diameter is under 6 px, so between 6 px and a recognisable size it is an unlabelled speck.
- **Fix direction:** Keep the ring icon under 6 px, but label a body whenever its projected radius is under about 40 px (and always when an icon overlaps it), with a priority above markers.

## 11. Lines that go behind a body bleed up to 6 px over the disc

- **Severity:** minor (artifact)
- **Screenshots:** `accept-landing-target.png` (two lines entering the lit lunar limb at x 405-412, y 348-354); `accept-occlusion.png` (stub over the Earth's limb at about (512,257), fade-in inside the dark limb at about (668,199)); `scene-lowOrbit.png` (orbit fading in over the dark limb at about (803,232)).
- **Checked:** visible at 10-16x: each line continues 5-6 px inside the disc as a fading stub.
- **Defect:** Occluded lines do not stop at the limb. Over the lit lunar limb the two lines show as short bright ticks lying on the surface, which reads as the line being in front of the body for a few pixels.
- **Real reference:** An occluded line vanishes at the limb; one to two pixels of softness is enough to avoid a hard cut.
- **Likely cause:** The hidden weight ramps from 0 at the limb to 1 only `OCCLUSION_FADE_PX = 6` px inside it (`src/map/constants.ts` line 26; `src/map/occlusion.ts` lines 48-50; `shaders.ts` lines 46-48).
- **Fix direction:** Reduce the ramp to about 1.5 px (or make it proportional to line width), keeping the smoothstep. If a cue for "goes behind" is wanted, keep the hidden part at a low constant alpha outside the disc instead of bleeding it over the disc.

## 12. Recovery-zone rings are visibly polygonal

- **Severity:** minor (both lenses; shares its fix with item 5)
- **Screenshots:** `accept-recovery-zones.png` (Central Pacific ring, right side around x 735-740, y 320-400; South Pacific ring around x 790-797, y 440-470).
- **Checked:** visible at 5x as straight chords with corners on the right-hand arc of the South Pacific ring; slight kinks at 1x.
- **Defect:** Seen face-on the rings are faceted and slightly wobbly. They are 2 px wide at 0.9 alpha, the most prominent strokes on the disc, yet are sampled with the tolerance meant for faint debris lines.
- **Real reference:** A circle of this size on a globe is a smooth curve; chord error under about a third of a pixel, as for the trajectory patches.
- **Likely cause:** `src/map/scene.ts` line 725 classes `recoveryZone` as faint, so `sampleLine` (line 767) uses `FAINT_CHORD_TOLERANCE_PX = 0.9` (`constants.ts` line 18), while `addZoneLine` (line 1055) draws it at `FAINT_LINE_WIDTH_PX + 0.5` with `COLORS.recovery` alpha 0.9.
- **Fix direction:** Sample zone circles with `CHORD_TOLERANCE_PX` (0.29); they are at most a handful of lines. This also cuts the chord sag behind item 5.

## 13. Debris orbits turn the Earth close-up into a grey scribble

- **Severity:** minor (photo)
- **Screenshots:** `synthetic-earth.png` (around x 430-1000, y 150-520).
- **Checked:** visible.
- **Defect:** Twenty debris orbits at equal weight run through the gizmo, the "Entry 10.85 km/s" label and the planet, with a dozen unlabelled dots and icons on top.
- **Real reference:** Shipped maps hide debris orbits by default (dots only, orbit on hover or by filter).
- **Likely cause:** `src/map/scene.ts` `addVesselOrbit` (from line 969; the draw call is line 1001) draws every non-controllable vessel's orbit in `COLORS.debrisOrbit` at 0.2 alpha.
- **Fix direction:** Draw debris as dots only, with the orbit on hover or behind a filter toggle.

## 14. Far-future planned patches: muddy short dashes that zip against each other

- **Severity:** minor (both lenses)
- **Screenshots:** `synthetic-earth.png` (dashed pairs at x 400-640, y 440-720); `synthetic-chain.png` and `scene-synthetic.png` (dashed lines between (530,545) and (640,360)).
- **Checked:** colour and doubled dashes visible at 3x. The crawl under camera motion is inferred from the code; no screenshot sequence with a moving camera and a dashed patch exists.
- **Defect:** Planned patches far ahead are drawn as short dashes (8 on / 6 off) faded to about a third alpha, which on black turns the orange and pink of the planned palette into muddy brown and mauve. Where two nearly coincident laps run 2-3 px apart their dash phases are unrelated and form a zipper pattern of low contrast. Inferred: the dash phase is the cumulative screen length from the patch start, so dashes slide along the path when the camera rotates or zooms and can jump when the start of the patch leaves the screen or the sampler changes its breakpoints.
- **Real reference:** Planned-orbit dashes keep a recognisable hue at any fade, future laps stay readable, and the pattern stays put on the path under camera motion.
- **Likely cause:** `src/map/scene.ts` lines 745-752 (`verts.len` accumulates projected segment lengths), `shaders.ts` lines 183-189 (dash from that length), `constants.ts` `DASH_PERIOD_PX` 14 / `DASH_ON_PX` 8, `FADE_FLOOR` 0.32 applied as alpha (`scene.ts` line 910).
- **Fix direction:** Anchor the dash phase at the patch's node end and derive it from a view-stable parameter (screen length measured outward from the node's projected point, or arc parameter scaled by the local pixel scale). Lengthen the dashes (12 on / 8 off). Fade planned patches toward a lighter tint of their own hue rather than toward black, and raise the floor for patches of the selected node or the lap the pointer is near. Record a short orbit-camera sequence of a dashed patch and check that a dash near the node stays within a pixel.

## 15. The node panel covers the trajectory just downstream of the node

- **Severity:** minor (photo; also raised by the artifact critic under the tooltip finding)
- **Screenshots:** `synthetic-moon-intercept.png` (panel x 843-1073, y 396-621); `accept-node-added.png`; `accept-prograde-drag.png` (prograde handle at (498,527) against the panel's edge).
- **Checked:** visible. The dashed planned line and the Moon's orbit run under the panel.
- **Defect:** The panel floats 92 px beside the node and covers the part of the trajectory that changes while the player drags a handle.
- **Real reference:** KSP docks the maneuver editor in a screen corner so the trajectory near the node stays visible.
- **Likely cause:** `src/map/controller.ts` `panelPlacement()` (line 733; offsets applied at lines 737-738) with `PANEL_OFFSET_X_PX = 92`, `PANEL_OFFSET_Y_PX = 28` (`constants.ts` lines 45-46).
- **Fix direction:** Dock the panel to a HUD edge, or place it on the side of the node away from the downstream trajectory, the prograde handle and the body centre.

## 16. The node panel is translucent and icons sit under it

- **Severity:** minor (artifact)
- **Screenshots:** `synthetic-moon-intercept.png` (panel x 842-1074, y 395-622; AN diamond at about (900,573)); `accept-node-added.png` (tooltip text behind the panel rows).
- **Checked:** visible at 4x: a faint diamond and line behind the "UT" row and the buttons. Faint at normal size.
- **Defect:** The dashed planned patch, the Moon's orbit line and the AN diamond show through the panel behind numeric fields the player types into. Icons are allowed to sit under the panel (hand-off known limit).
- **Real reference:** An input panel is opaque or uses a blurred backdrop; nothing sharp shows behind text fields.
- **Likely cause:** `src/map/panel.ts` line 16: `background: rgba(10, 15, 22, 0.94)`; the canvas overlay keeps drawing lines and icons under the panel rectangle.
- **Fix direction:** Make the background opaque (or add `backdrop-filter: blur` with an alpha 1 fallback), and skip icons whose centre lies inside the blocked panel rectangle.

## 17. Icons do not say what they are

- **Severity:** minor (photo)
- **Screenshots:** `accept-zoom-1e9m.png` (two near-identical ring-and-dot icons at (630,361) and (640,360)); `accept-node-added.png`; `scene-synthetic.png` ("Enter Moon" and "Exit Moon" icons).
- **Checked:** visible. Ap and Pe are the same light-blue ring with a dot; the vessel is the same shape in white; both SOI crossings are the same yellow double ring.
- **Defect:** Apoapsis and periapsis share one glyph, the active vessel is the same ring-and-dot in white, and SOI entry and exit share one double ring. Only the text tells them apart, and text is the first thing de-cluttering removes.
- **Real reference:** KSP tags apsides "Ap" / "Pe" in the marker itself; shipped maps give the player's craft a distinct solid glyph pointing along its velocity and use arrows for entering and leaving an SOI.
- **Likely cause:** `src/map/gpu/shaders.ts` `shapeSd()` (line 261): case 0 (apsis) for both apsides, case 11 (vessel) is a ring with a core, case 2 (soi) for both crossings.
- **Fix direction:** Distinct apsis glyphs (up / down chevron in the ring, or the letters), a solid oriented chevron for the active vessel, inward / outward arrows for SOI entry / exit.

## 18. From inside the Moon's SOI its boundary is drawn as a line that reads as a second orbit

- **Severity:** minor (photo)
- **Screenshots:** `accept-landing-target.png` (two near-parallel lines across the frame at y 343-372, one dimmer, both passing behind the Moon).
- **Checked:** visible: two lines beside each other where a player expects one Moon orbit.
- **Defect:** With the camera inside the Moon's SOI the boundary is drawn as a great circle in the orbit plane, which appears as a straight line through the Moon beside the Moon's real orbit line.
- **Real reference:** Maps show an SOI as a shell seen from outside; from inside nothing is drawn.
- **Likely cause:** `src/map/scene.ts` `addSoiLine`, the `else if (b.orbit)` branch (lines 1011-1016).
- **Fix direction:** Draw no SOI line while the eye is inside the sphere.

## 19. Distances in megametres and "T-0.0s"

- **Severity:** minor (photo)
- **Screenshots:** `scene-translunar.png` ("Pe 180.0 Mm", "Ap 180.0 Mm"); `scene-synthetic.png` ("Ap 425.6 Mm", "Closest 358.2 Mm"); `scene-lowOrbit.png` ("T-0.0s").
- **Checked:** visible.
- **Defect:** Distances switch to megametres, a unit no mission display or shipped game uses, while the HUD beside it writes the same quantities in km ("6 087.9 km"). An event happening now reads "T-0.0s".
- **Real reference:** NASA displays and KSP use km with digit grouping at these ranges.
- **Likely cause:** `src/map/format.ts` `formatDistance` (line 11, `Mm`) and `formatTimeTo` (line 45).
- **Fix direction:** km with thin-space grouping up to at least 1e7 km, matching the HUD's formatter; "now" when |t| < 1 s.

---

**Dropped:** none. **Not confirmed from a still, kept with that caveat:** the frequency and popping of item 1's false line, the pick stealing in item 4, the behaviour over the real renderer in item 8, the dash crawl in item 14.
