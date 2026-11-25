REVIEW OF shell-menu (wave 4.1). I changed nothing in the repository; the scratch directory is deleted.

**Verdict: not acceptable as finished.** The skeleton is sound and honest in intent, but there are 3 blockers and 15 majors in flows an ordinary player reaches, and the front end is a 4/10 against the AAA bar. The hand-off itself opens with "The package is NOT finished".

What I ran (all through the gate):
- Unit, the requested command: 162 pass, 1 fail. The failure is `tests/unit/fakes/deprecated.test.ts` rule "html" on root `index.html:106` (the capability gate's inline script, not this package's file).
- Unit, `src/input tests/unit/shell tools/dev/boundaries.test.ts`: 142 pass. `typecheck:paths` for the package's paths: OK.
- Browser, `tests/browser/menu --project=functional`, once: 14 passed, 1 failed in 8.3 min. The failure is the night test, on the known spot-shadow warning (shell-menu-5), after its own assertions passed (hand-over 11.37 EV, settled 11.40).
- From that run: day contrast worst 5.00:1 (Credits); transit 599 frames, 0 off the path. The run rewrote the pictures in `out/screens/shell-menu` under the same names.
- Two scratch `tsx` simulations of `spawnFlow.ts` and `machine.ts`; the results are cited as "sim A–E" and "machine sim" below.
- The perf project was not re-run; `perf.json` is the builder's.

Path legend (absolute):
- SHELL = `C:\dev\fable-space-game\src\shell\shell.ts`
- SCREENS = `C:\dev\fable-space-game\src\shell\screens.ts`
- FLOW = `C:\dev\fable-space-game\src\shell\spawnFlow.ts`
- MACHINE = `C:\dev\fable-space-game\src\shell\machine.ts`
- IDENT = `C:\dev\fable-space-game\src\shell\identity.ts`
- KIT = `C:\dev\fable-space-game\src\shell\dom\kit.ts`
- LEAVE = `C:\dev\fable-space-game\src\shell\leaveOutcome.ts`
- RULESVIEW = `C:\dev\fable-space-game\src\shell\rulesView.ts`
- LAB = `C:\dev\fable-space-game\labs\shell\main.ts`
- Pictures: `C:\dev\fable-space-game\out\screens\shell-menu\`

## PART A — The screens

All 54 PNGs were read; small type was cropped and enlarged.

### Across every screen

- **Composition is scaled, not composed.** One left column (columns 1–5, 7 when wide) in the unit `u`. 720p, 1440p and 4K are the same picture. Ultrawide is the 16:9 frame centred, with about 516 px of empty band each side.
- **720p clips; larger sizes only just fit.** At 720p the pixel floors make type relatively larger, so Universe, Credits and the pad list are cut mid-line. At 1440p and above they fit with the status line touching the panel. There is no 1920x1080 picture in the set.
- **Body type is under the spec floor.** At 1080p the rules text, row sub-lines and credits are 13.5 px and captions 11.9 px; frontend-ux 4.3 sets body at 1.5u with a 14 px floor. At 720p much of it is 11–12 px.
- **Units glue to numbers.** Thin spaces collapse in the condensed face: "20210m/s", "2756t".
- **The accent is not the briefed one.** It is the HUD's cyan on cool white, not Dawn Line amber on warm white, and the hand-off does not say so. Amber is then the warning colour and marks the queue, so the queue reads as a fault.
- **Panels have no constant value.** Near-black on Play; a milky grey slab on Hangar, Choose a craft and the Launch card.
- **The scrim shows artifacts.** Its blurred copy appears as a hard-edged bright block behind text (Credits x515–700, Universe x390–605, My Ships x385–480) and as a 150 px grey band that does not line up with the real limb (`backdrop-day-hub-credits`). Fix: cap the scrim's luminance, use a real blur radius, and give every plate one value.
- **Focus is not designed.** It is a fill change, a 3 px bar and Chrome's default focus ring. The 1.03 card scale sits inside an `overflow-x: hidden` column (KIT:91, 154), so the ring is cut on the left on the hub cards and on both sides of "I have saved it". Mouse hover shows no ring. Fix: a 2 px inset accent outline and no scale inside a clipping box.
- **It reads as a web form in places.** Hollow circle bullets look like radio buttons. Scrollbars are hidden with no scroll cue, so cut content looks like a bug.
- **Navigation chrome is confusing in the deploy flow.** The tab bar stays on deploy and identity screens with nothing selected, and there is no step indicator.
- **The status line is internal.** "SOL · PUBLIC UNIVERSE 1 · RULES DEFAULT V1" sits on clipped panels.
- **No card has an image.** No picture shows motion.

### Per screen

1. **Title** (four sizes).
   - Works: the wordmark; the limb.
   - Does not: "Press any key" is a small plate at bottom right on the brightest part of the limb. Its CSS meant it centred (KIT:187), but it is mounted in the aside (SCREENS:150). There is no online or in-flight count, no UT and no build. The Fullscreen prompt weighs as much as the call to action. The limb is a flat grey band.
   - Fix: a centred call to action with a slow opacity pulse; presence top right; UT bottom right; the ticker with a "LIVE" kicker.

2. **Cold start.**
   - Works: honest per-step bars.
   - Does not: a black screen with a developer table ("TYPE", "RENDER FEATURES"); the panel's right border is clipped.
   - Fix: one line and one bar under the wordmark ("Loading the hangar · 62 %") in player words.

3. **Hub / Play** (four sizes, plus the offline picture).
   - Works: three cards, one focused; the lobby row with population.
   - Does not: the cards are 160x130 px text boxes in the top-left quarter. Their titles sit on three baselines (y 225, 243, 208). The disabled Resume card's reason is 2.8:1. The lobby sub-line is jargon ("Shared clock at 1x; warp by agreement, alone or on a private clock"). 60 % of the frame is empty at every size.
   - Fix: cards twice the size with real renders, a common title baseline, Launch visibly primary, and a one-line lobby row ("1 284 flying · ships kept 14 days").

4. **Hangar and Choose a craft.**
   - Works: the live vehicle on its pad is the right idea; the read-outs are real.
   - Does not: the stack is about 250 px tall and half hidden behind the detail panel; a lattice mast crosses the list. Seven of eight rows say "Not yet available · its models are still being built" at 1.1–1.5:1, and the eighth is below the fold with no cue. The Hangar has no primary action: you cannot launch the craft you are looking at. "Can reach: Moon flyby, Moon orbit" sits under "Direct-ascent lunar landing and return". "cabin" is lower-case and the pad-class line repeats the grid. In `hub-hangar-1280` and `deploy-vehicle-1280` no vehicle is visible at all.
   - Fix: frame the whole stack in the truly free area (finding B15), at 60 % or more of frame height; collapse unavailable craft into one line; Enter = "Launch this craft"; a stage strip as the hero interaction.

5. **Choose a pad** (four sizes).
   - Works: the site header with local time and sun; the pad states.
   - Does not: it is an admin table. The class is stated three times a row, and seven of nine rows are unusable and dim (1.3–2.8:1). The list is cut mid-row at 720p. The second site (Madrakah) is below the fold with no hint it exists. The globe behind is blurred and blocky with no site or pad marked on it. "RESERVE" is the verb, and "FREE IN 2:00" is a precise countdown.
   - Fix: list only the pads that take the craft; two site cards (day and night); markers on the globe; one recommended pad pre-focused.

6. **Briefing.**
   - Works: one large Launch card.
   - Does not: a label-and-field form. Nothing says the name is editable. "SLOT · Live clock, now" is jargon. The Launch card is a banded grey slab over a bright Earth. No pad or vehicle is in view, and the Practice subtitle wraps to an orphan word.
   - Fix: the camera on the pad from 2–3 km; the briefing as a bottom strip; Launch in the accent.

7. **Launch queue** (three pictures).
   - Works: honest words — the place, "Estimated wait about 1 min", "it can grow as well as shrink", the Leave key, the stale note.
   - Does not: it is neither calm nor unmistakable.
     - The place is the fourth panel of the left column, at 28 px.
     - The primary card says "WAITING FOR A PAD" at about 2.5:1 over the bright Earth (my sampling).
     - The prompt bar still says "ENTER LAUNCH".
     - In the reconnecting picture the stale note is cut at "comes back in time." and the "Leave the queue" row is pushed out of the panel.
     - The top bar still shows "LINK 42 MS" and "1 284 ONLINE".
     - After leaving, the same sentence appears twice.
     - The panel never names the craft or pad that waits.
     - No picture exists of the lost place on takeover or of the admission queue.
   - Fix: the Launch card becomes the queue card — "3RD IN LINE" at title size, "about 1 min · estimate", the craft and site, and Leave. List the other offers under it. Stale dims the card with "Reconnecting — last known place" in full ink. Use a neutral rule, amber only for stale.

8. **Spawn refused.** The reason and alternative are good. The alternative is a text link and uses "LC-2" where the list says "Launch Complex 2 (heavy)". Focus stays on the refused pad.

9. **Offline banner.** Plain words. But Launch (live) is still enabled and focused, the lobby row is still green at "42 ms", and "[ENTER] PRACTICE OFFLINE" is false while focus is on Launch (B7).

10. **Transit.** The dive over real cloud is the best frame of the set. The title and status say the same thing twice. The holding frame is a white-out (the camera is inside the cloud deck at 3 km), with "Securing range…" at about 3–4:1: in effect a loading screen. Fix: hold where the pad is in view.

11. **Flight hand-over, day and night.** Good. The top of the stack is cut (known). There is no HUD in the lab.

12. **Flight menu.** Calm and clear. But "Fake vessel is rolled back from the pad… Your ship is kept for 14 days" contradicts itself (B14), and "your craft keeps flying" is shown on the pad.

13. **Identity.** One field and a live verdict: good. GENERATE, COPY and DOWNLOAD are bare caps text. "[F] Generate" is false while the field has focus (F types an F). The Confirm card is a large empty box. The code is not in a mono face.

14. **My Ships.** Every row is disabled at 2.85:1, including "24 h EXPIRES SOON". It shows "kept / KEPT FOR". The prompt bar offers Resume, Rename and Abandon on rows that cannot resume. Fix: rows always readable, with the expiry as the right-hand hero.

15. **Universe.** Every number comes from the rules. It is a wall of 12–13.5 px engineering prose ("a hard dock after 0.5 s within 3 mm, 0.1° and 3 mm/s", "stored objects", "cohort clock: buckets of 5 min"), cut mid-sentence at 720p, with two sections below the fold. Fix: four large read-outs first (ships kept, slots, warp, collisions), details behind them, 16 px body.

16. **Settings.** Clean, but three rows; Enter only cycles values.

17. **Credits.** Complete. A 12 px list, clipped, with the grey block behind it; no group headings.

### Score: 4 / 10

### The three changes that matter most

1. **One hero per screen over a constant dark plate.** Fix the scrim value and its artifacts, hand the camera a truly free area and frame the subject in it (the turntable, the site on the globe, the pad at the briefing), and give the cards real renders.
2. **Make waiting and unavailable states first-class.** The queue as the primary card; every information-bearing "disabled" text at 4.5:1 or better; no clipped panels; scroll cues.
3. **A type and wording pass.** Body at 1.5u, half the words, player language, numbers with units, a designed focus state, and a title screen with presence and a centred call to action.

## PART B — Flow and code

### Blockers

**1. The recovery code can be lost for ever.**
- Where: IDENT:199 blocks only `menu:back`; SHELL:254-267 draws live tabs on the screen; SHELL:519-526 and MACHINE:83-84 let Q, E or a tab click clear the overlay.
- Problem: once the overlay is gone the callsign exists, so `needsIdentity` is false and the code is never shown again. The same happens with Esc during "Creating…" (IDENT:69-83).
- Evidence: machine sim — `hub/play/identity` plus a tab event gives `hub/credits`. The browser test presses only Escape.
- Fix: make creating and shown a modal state with no tabs or banner; keep the code reachable until confirmed; clear `flow.recoveryCode` on done.

**2. Abandon is one keypress with no confirmation, and Rename is a no-op.**
- Where: SCREENS:637-638; Delete is bound in `C:\dev\fable-space-game\src\input\contexts.ts:81`.
- Problem: Delete calls `abandon(craftId)` at once and discards the result. frontend-ux 5.12 requires a confirmation that states the rule's effect. Rename sends the unchanged name.
- Fix: a confirm card, a name field, and result and error shown.

**3. A waiting launch request is orphaned by ordinary navigation.**
- (a) Back three times from the briefing reaches the hub with the request still queued (SHELL:505-518). No hub or vehicle screen shows it. When it is seated only `spawnAcknowledged` is sent (SHELL:137-142), so the vessel is on the pad and the player is in the hub. Evidence: sim C.
- (b) "Practice offline" while queued swaps the flow without `cancelSpawn` (SHELL:113-120). A fresh flow starts idle and ignores a non-null store entry (FLOW:49, 60-61).
- (c) Back out of a held transit calls `leaveQueue` on an unqueued request, which is a no-op (SHELL:472-477). The request stays in flight, and the next launch for another pad receives the old request's answer (FLOW:74). Evidence: sim D — "phase = seated slow".
- Fix: one owner of the request. Leaving the deploy flow or switching session cancels it, or it follows the player as a visible chip whose seat always starts the transit. A new flow adopts an existing entry. A different request while one is pending is cancel-then-spawn or a visible refusal. The lead should decide how an unqueued spawn is cancelled.

### Major

**4. "Choosing another offer is cancelSpawn and a new spawn" is not wired.**
- Where: `SpawnFlow.choose` has no caller; SCREENS:563-569.
- Problem: Launch is inert while queued. Picking another pad or the cohort row opens a briefing for the new choice under the old request's queue panel.
- Also: `choose` double-spawns if the seat lands during the cancel (FLOW:102-109; sim A: "…seated > requesting").

**5. The visible expiry rules are wrong and incomplete against ARCHITECTURE 15.5.**
- Where: RULESVIEW:108; SCREENS:557, 626; LEAVE:86.
- Problem: the screens say "kept 14 days after you last fly it". The rule is 14 days after the owner's last session, and any session renews all craft. The pressure rule (retention shortening to 24 h / 72 h above 70 % of the cap), which 15.5 says "the rules screen states", is absent. So are docking's effect on expiry and the clock used.

**6. The host cannot end a flight the player did not leave.**
- Where: MACHINE:109-112.
- Problem: from flight or the flight menu the only exits are the menu and leave (machine sim). A pad roll-back after the maximum stay, a takeover, a destroyed vessel or a session lost in flight has no event and no explanation card. A refused resume has no Shell API and no place to show its reason.

**7. An unreachable link does not gate the live flow.**
- Where: SCREENS:187, 197; SHELL:332-340, 281-287.
- Problem: only the lobby status disables Launch. The banner's cap says Enter is Practice, but Enter activates the focused Launch card. Stale RTT and online counts stay on screen. The banner test clicks for this reason (`C:\dev\fable-space-game\tests\browser\menu\practice.spec.ts:54-55`).

**8. Any store change rebuilds the whole screen at up to 10 Hz.**
- Where: SHELL:152-162, 403-406, 640-644.
- Problem: with live stores, a click whose press and release straddle a rebuild is lost, and lists re-scroll to the focus (SHELL:438). The fixtures never change at rest, so neither the mouse test nor the 0.14 ms figure covers this path.
- Status: by reading, not run.
- Fix: patch live text in place; add a fixture that ticks its stores and re-run the mouse and perf specs.

**9. The queue's edge states are wrong or mislabelled.**
- Where: FLOW:65, 83, 96-101.
- Problem: stale covers only 'reconnecting', so with the link 'offline' and the entry still in the store the place shows as live. A loss past the grace is labelled 'refused', or 'left' if a leave was attempted while reconnecting. `leaveQueue` has no catch, and its callers use `void` (sim E).
- Also: the clipped stale note and missing Leave row from A7.

**10. Text that carries information is exempted as "disabled" and is unreadable.**
- Where: KIT:156 (opacity 0.45); `C:\dev\fable-space-game\tests\browser\menu\menuPage.ts:159`.
- Evidence (`contrast-day.json`): Hangar "pad class" 1.06; "Not yet available…" 1.48; every My Ships row 2.85, expiry included; the Resume reason 2.82.
- Never measured: the identity screens, the queue and refused panels, the banners, the lobby, controls and the transit.

**11. My Ships cannot be read by keyboard when rows are disabled.**
- Where: SHELL:441-444.
- Problem: navigation skips them, so Down jumps to the tab bar and the detail stays on the first ship. Today one of eight vehicles is presentable.

**12. A rejected spawn promise stops all launching until reload.**
- Where: FLOW:79-90.
- Evidence: sim B — the phase stays 'requesting' and the second call returns the same rejected promise.

**13. A failed callsign check is retried every text tick for ever.**
- Where: IDENT:123-141.
- Problem: `checkedName` is not set on error, so a rate-limited service is hammered.

**14. The leave line contradicts itself.**
- Where: LEAVE:58 and 86; SCREENS:199, 556.
- Problem: on the pad it says "rolled back" and then "kept for 14 days". In Practice it says "Your ship is kept." against "Nothing is kept".

**15. The "free area" given to the camera is not free.**
- Where: SHELL:368-372.
- Problem: it ignores the aside panel, so the turntable subject is centred behind the detail panel. The hand-off blames the lab's eye.

**16. Launches per hour is unblocked but not shown.**
- Where: request `C:\dev\fable-space-game\docs\requests\shell-menu-1.md` is "resolved (lead, 2026-11-24)"; LAB:236 still passes `padCycleSeconds: () => null`.
- Problem: `UniverseRules.pads.meanCycle` exists, and the hand-off still calls the request open.
- On the question asked: nothing pretends in its place. The pad screen states the pad count and a wait from `PadState.nextLiveTick`. The queue's wait is the store's `etaSeconds`, worded as an estimate. The fixture's estimate only ever shrinks, so "can grow" is untested.

**17. The lab hides flow gaps.**
- Where: LAB:243-289, 258.
- Problem: it has no InputSystem, so the context intent is dropped and `setContext` has no caller or test anywhere. The `resume`, `watchPad` and `trackShip` intents are ignored; a resume would hang in transit for ever. The transit ignores the request's site and pad and always dives to LC-1. Nothing ever sets the side states calibrate, queued, reconnecting or blocked.

**18. No IME guard on the menu's key handler.**
- Where: SHELL:533-562.
- Problem: the Enter that commits a composition in the craft-name field launches. `inputSystem.ts:129` has the guard; the shell does not.

### Minor

**19. Title keys.** Back, mouse-back or any non-F action begins the game (SHELL:480-486). F5, F11 and Tab are swallowed as "any key" (SHELL:541-545). The capture control is built, never mounted, and is the screen's focus id (SCREENS:130, 158).

**20. Mouse back button.** It may be handled twice — the explicit call plus the browser's popstate (SHELL:593-598) — and is swallowed in flight. By reading; check with a real mouse.

**21. Hover against keyboard.** `pointerover` moves focus with no "pointer moved" guard (SHELL:563-566), so focus can snap back while a list scrolls under a resting pointer. By reading.

**22. Tab key.** Every control has `tabIndex -1` (KIT:221), so Tab does nothing useful. ARIA is tablist and tab only.

**23. Unescaped ids in selectors.** SHELL:414, 433 and 500 build selectors without `CSS.escape`; an id with a quote throws inside render. Injection itself is clean: there is no `innerHTML` or similar anywhere in `src/shell`, the fakes or the lab, and every string goes through text nodes.

**24. Long or hostile names.** No ellipsis, nowrap or bidi isolation on names and the ticker. The craft-name field shows upper case by CSS but sends the typed case. The only length limit is `maxLength` 32.

**25. Three number rules.** The HUD formatter (thin space), commas in RULESVIEW:36-43, and `toLocaleString` with a broken ordinal in the admission banner ("You are 214 in line", SHELL:364).

**26. Controls reference.** Unreachable from the hub: nothing sends the overlay. Menu keys are listed by internal ids ("prevTab", "secondary", "remove"; SCREENS:726).

**27. Transit title.** It repeats, and a resume shows the last visited pad's name (SCREENS:771-776).

**28. In flight.** The root is hidden and the scrim is published empty (asserted in my run). The window and document listeners stay, and store changes still run `render()` at up to 10 Hz (SHELL:391-399). `visited` grows without bound (MACHINE:168). No test opens and closes the menu 100 times; by reading, nothing else accumulates.

**29. Small-window overlay.** It covers the page but keys still drive the menu (KIT:206-207).

**30. Takeover and admission wording.** A takeover while queued leaves the player on the briefing with Launch enabled and a banner with no action. "Waiting for a place in the lobby" is also shown for maintenance and incompatible (SCREENS:197).

**31. Settings.** Values only cycle on Enter; scale and reduced motion are not stored.

**32. Credits and fonts.**
- Credits: 18 entries cover all nine Earth bake sources, GLO-30, four Moon, two sky, ElevenLabs and Barlow. The 35 planet-bake sources are the activation package's merge, as briefed.
- For the lead: "Global cloud map — No licence stated by the service" ships without a licence, and Sentinel-2 cloudless is CC BY-NC-SA.
- Fonts: seven WOFF2 files and `OFL.txt` under `C:\dev\fable-space-game\public\assets\ui\fonts\`, loaded from `/assets/ui/fonts/`. No third-party host in either `index.html` or the CSS.

**33. Recovery code handling.**
- Held in the shell's `IdentityFlow` until "I have saved it", in the `.sh-code` node, and in a blob URL revoked after 1 s.
- No log or storage write.
- `identity-recovery-1280.png` stores the fixture's code; mask it once a real service exists.

**34. Leave guard.** `shouldGuardUnload` (LEAVE:28-34) is correct and unit-tested but unused. `C:\dev\fable-space-game\src\app\game.ts:342` still arms the guard for a scenario-less session (request shell-menu-2 is open).

### Checked and sound

- The offer order (first-offer presentable, then other presentable, then the rest disabled): SCREENS:301-308.
- The pad class comes from `capabilities().padClass`; `padTakes` matches `validate.ts:253-256`.
- Text fields type W, S and Space; a held key is not a press in the next context (`inputCore.ts:160`).
- No Ctrl, Alt or Meta in any table.
- Stale mark and place kept across a reconnect: unit-tested.

## PART C — Brief against evidence

| Requirement | State | Evidence |
|---|---|---|
| Binding tables (no Ctrl/Alt/Meta, no conflicts, reachable) | Proven | Unit, my run. X (`menu:stages`) is bound to nothing. |
| Rules screen: default and staging, different numbers, no code change | Proven | Unit, my run. Content fails 15.5 (B5). |
| Credits: every source and licence on screen | Proven | Browser, my run. |
| Keyboard deploy flow with focus per step, at 1280x720 | Proven | Browser, my run. "Control enabled" is only the state 'flight'; the lab has no controller. |
| The same by mouse | Proven | Browser, my run, on static stores (B8). |
| Back from every screen | Partly proven | Tabs, deploy steps, browser Back and the recovery card are tested. Lobby, controls, flight-menu panels and the transit hold are not. |
| Four resolutions | Claimed as met; partial | The three larger sizes open four screens each. No briefing, transit or flight above 720p. |
| Transit on its path | Proven | 599 frames, 0 off the path; always to LC-1. |
| No transit frame at or above 33 ms | Claimed | Builder's `perf.json` (worst 27.0 ms); not re-run. |
| HUD only after the spawn gate | Not done | No HUD in the lab. |
| Holding drift on a slow acknowledgement | Proven | Browser, my run. The picture is a white-out. |
| A refused spawn re-targets | Proven as rise-back plus an offered alternative | Browser, my run. |
| Night exposure within 1 EV at hand-over | Measured, test red | 0.03 EV in my run; fails on shell-menu-5. |
| Contrast at least 4.5:1 on every text box | Proven for enabled text on 11 day and 2 night screens | Informative disabled text exempt (1.06–2.9:1). Identity, queue, banners, lobby, controls and transit unmeasured. Not the brightest frame. |
| Menu DOM at most 0.5 ms a frame; text at most 10 Hz | Claimed | Builder's `perf.json` (0.14 ms, 9.5 Hz), on static stores only. |
| Practice by keyboard, requests blocked | Proven on a fixture | Not a LocalSession; 0 requests were blocked because the lab makes none. |
| Practice from an unreachable server | Partly | By pointer click, not keyboard (B7). |
| Cold start | Proven on lab flags | `planet=1`, `holdboot=1`. |
| Visible launch queue: place, estimate, leave, stale, takeover | Partly proven | Place, estimate, leave and stale in the browser; takeover in unit only. Other offers not wired (B4); orphaning (B3). |
| Launches per hour per class | Not done | Unblocked (B16). |
| FakeSession conformance; wave-2 flight-ui, map and audio specs | Conformance passes; the scan beside it is red; wave-2 not run | My unit run. |
| Input contexts with release-all | Claimed | Implemented; no test, no caller. |
| Side states calibrate, queued, reconnecting, blocked | Claimed | Machine only; nothing sets them. |
| Camera rigs (menu, turntable, transit via `CameraRig.activate`) | Partly | Pure path functions and lab glue; no rig objects. |
| Leave guard rule | Claimed | Function and unit test; unused. |
| Identity | Proven on a fixture | Flawed (B1). |
| Settings from the SettingsModel; graphics rows | Not done in the lab | The host is null; three rows. |
| Resume transit; spectate; watch pad | Not done | |
| Exploded stage view | Not done | |
| Launch-window readout, window slot, friend's clock | Not done | **Not stated in the hand-off.** |
| Site selection over the live globe | Not done | A list only. |
| My Ships rename; abandon confirmation | Not done | B2. |
| Controls reference from the hub | Not done | B26. |
| Expiry rules visible (pressure, docking, clock) | Not done | B5. |
| Audio (buses, UI sounds, score) | Not done | Stated in the hand-off. |
| HUD and map labels on the shipped type | Not done | Request shell-menu-4. |
