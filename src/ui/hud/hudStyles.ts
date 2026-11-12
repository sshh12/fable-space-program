/**
 * HUD stylesheet. Every size derives from --u = min(1vh, 0.5625vw) (one hundredth of the height of a 16:9
 * frame), so the layout is identical from 1280 x 720 to 3840 x 2160 and never overflows narrower windows.
 *
 * The frame belongs to the scene: two narrow side columns (25u / 25.5u), one instrument housing at the bottom and one
 * altimeter plate at the top keep the HUD within a fifth of a 16:9 frame (asserted on the screenshots). Panels are opaque plates
 * (the theme's `panel` fill): a scene edge behind a plate stays below a few levels, so a horizon never draws a
 * line through a row of text; every plate has a light hairline, a dark outer ring and a lit top edge so its edge
 * reads on bright and dark scenes alike. Numerals are tabular; no text is smaller than 0.76 em of the 13.3 px
 * base at 720p (10 px).
 */
import { UI_COLORS, UI_FONT_FAMILY } from '@/core/ui/theme';

export const HUD_STYLE_ID = 'fable-hud-style';

export const HUD_CSS = /* css */ `
.hud {
  --u: min(1vh, 0.5625vw);
  --bg: ${UI_COLORS.panel};
  --bg-top: rgba(22, 30, 42, 0.975);
  --bg-strong: ${UI_COLORS.panelStrong};
  --line: ${UI_COLORS.line};
  --edge: 0 0 0 1px rgba(0, 0, 0, 0.42);
  --lit: inset 0 1px 0 rgba(255, 255, 255, 0.07);
  --text: ${UI_COLORS.text};
  --label: ${UI_COLORS.label};
  --dim: ${UI_COLORS.dim};
  --accent: ${UI_COLORS.accent};
  --good: ${UI_COLORS.good};
  --caution: ${UI_COLORS.caution};
  --warning: ${UI_COLORS.warning};
  --gap: calc(var(--u) * 1.4);
  --lcol: calc(var(--u) * 26.5);
  --rcol: calc(var(--u) * 25.5);
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  font-family: ${UI_FONT_FAMILY};
  font-size: calc(var(--u) * 1.85);
  line-height: 1.25;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  text-shadow: 0 0.06em 0.14em rgba(0, 0, 0, 0.55);
  user-select: none;
  -webkit-user-select: none;
  contain: strict;
}
.hud[hidden] { display: none; }
.hud * { box-sizing: border-box; }
.hud [hidden] { display: none !important; }
.hud[data-kind="interior"] [data-show]:not([data-show~="interior"]),
.hud[data-kind="external"] [data-show]:not([data-show~="external"]),
.hud[data-kind="map"] [data-show]:not([data-show~="map"]) { display: none !important; }

.hud .panel, .hud .later, .hud .tile:not(.compact) {
  background: linear-gradient(180deg, var(--bg-top), var(--bg) 40%);
  border: 1px solid var(--line);
  border-radius: calc(var(--u) * 0.8);
  box-shadow: var(--lit), var(--edge), 0 calc(var(--u) * 0.3) calc(var(--u) * 1.4) rgba(0, 0, 0, 0.28);
}
.hud .panel { padding: calc(var(--u) * 0.5) calc(var(--u) * 0.95); contain: layout style; }
/*
 * The interface's two materials. Flight readouts are panes of the cockpit displays' black glass (the MFD pages:
 * near-black face, a header strip with the title as the active tab - accent text over an accent underline - and a
 * status edge on the left in the colour of the panel's state): the left column, the altimeter, the maneuver readout
 * and the right column (the stage list under its header, resources). The bottom cluster is one instrument housing
 * in the navball bezel's machined gunmetal carrying the SAS controls, the ball and the gauges, with black-glass
 * windows for the ball's read-outs.
 */
.hud .lcol .panel, .hud .tc .alt, .hud .bottom .node, .hud .rcol .res, .hud .rcol .later, .hud .stagewrap .more {
  background: linear-gradient(180deg, rgba(11, 17, 26, 0.985), rgba(5, 8, 13, 0.975) 2.2em);
  border-color: rgba(120, 150, 190, 0.3);
}
.hud .lcol .panel, .hud .bottom .node, .hud .rcol .res { position: relative; --st: rgba(85, 212, 255, 0.5); }
.hud .bottom .node { --st: #4f8dff; --tab: #9fc0ff; }
.hud .lcol .panel::before, .hud .bottom .node::before { content: ''; position: absolute; left: -1px; top: -1px; bottom: -1px; width: calc(var(--u) * 0.34); border-radius: calc(var(--u) * 0.8) 0 0 calc(var(--u) * 0.8); background: var(--st); }
.hud .lcol .panel[data-st="good"] { --st: var(--good); }
.hud .lcol .panel[data-st="caution"] { --st: var(--caution); }
.hud .lcol .panel[data-st="warning"] { --st: var(--warning); }
.hud .lcol .panel > .ptitle, .hud .tc .alt > .ptitle, .hud .bottom .node > .ptitle, .hud .rcol .res > .ptitle {
  margin: calc(var(--u) * -0.5) calc(var(--u) * -0.95) calc(var(--u) * 0.4);
  padding: calc(var(--u) * 0.34) calc(var(--u) * 0.95) calc(var(--u) * 0.32);
  background: rgba(16, 26, 38, 0.95);
  border-bottom: 1px solid rgba(120, 150, 190, 0.26);
  border-radius: calc(var(--u) * 0.8) calc(var(--u) * 0.8) 0 0;
}
.hud .tc .alt > .ptitle { margin: calc(var(--u) * -0.4) calc(var(--u) * -1) calc(var(--u) * 0.3); }
.hud .lcol .panel > .ptitle > span:first-child, .hud .tc .alt > .ptitle > span:first-child, .hud .bottom .node > .ptitle > span:first-child, .hud .rcol .res > .ptitle > span:first-child, .hud .stagewrap .more > span:first-child { color: var(--tab, var(--accent)); position: relative; }
.hud .lcol .panel > .ptitle > span:first-child::after, .hud .tc .alt > .ptitle > span:first-child::after, .hud .bottom .node > .ptitle > span:first-child::after, .hud .rcol .res > .ptitle > span:first-child::after, .hud .stagewrap .more > span:first-child::after { content: ''; position: absolute; left: 0; right: 0; bottom: calc(var(--u) * -0.34); height: max(1.5px, calc(var(--u) * 0.22)); background: var(--tab, var(--accent)); border-radius: 1px; }
/* Machined gunmetal of the bottom housing: lit from above like the bezel (bright top chamfer, dark lower edge). */
.hud .bottom .housing {
  background: linear-gradient(180deg, #3d4652 0, #2c333c calc(var(--u) * 0.9), #252b32 30%, #21272d 100%);
  border: 1px solid rgba(0, 0, 0, 0.72);
  box-shadow: inset 0 1px 0 rgba(225, 235, 248, 0.42), inset 0 -1px 0 rgba(0, 0, 0, 0.55), inset 1px 0 0 rgba(225, 235, 248, 0.06), inset -1px 0 0 rgba(0, 0, 0, 0.35), 0 calc(var(--u) * 0.3) calc(var(--u) * 1.6) rgba(0, 0, 0, 0.38);
}
/* Black-glass windows set into the housing and the bezel, each in a thin gunmetal frame. */
.hud .bottom .speed, .hud .bottom .prw {
  background: linear-gradient(180deg, rgba(11, 17, 26, 0.995), rgba(4, 7, 11, 0.995));
  border: 1px solid rgba(0, 0, 0, 0.8);
  box-shadow: 0 0 0 calc(var(--u) * 0.22) #2e3640, 0 0 0 calc(var(--u) * 0.22 + 1px) rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 calc(var(--u) * 0.2) calc(var(--u) * 0.8) rgba(0, 0, 0, 0.35);
}
.hud .bottom .sas button { background: linear-gradient(180deg, #252c35, #171b21); border-color: rgba(0, 0, 0, 0.7); box-shadow: inset 0 1px 0 rgba(225, 235, 248, 0.16); }
.hud .bottom .sas button:hover { background: linear-gradient(180deg, #2c4a5e, #1b2d3a); border-color: rgba(120, 200, 255, 0.45); }
.hud .ptitle {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: calc(var(--u) * 1);
  font-size: 0.78em;
  font-weight: 600;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  color: var(--label);
  margin-bottom: calc(var(--u) * 0.25);
}
.hud .ptitle .pname { color: var(--text); letter-spacing: 0.02em; text-transform: none; font-size: 1.22em; font-weight: 600; }
/*
 * Relayout boundaries: every box whose text changes at the 10 Hz text rate (label/value rows, apsis rows, clock
 * lines, the big readouts, gauge values, the navball read-outs) has a fixed height and contain: size layout, so
 * a changed number lays out only its own line instead of its panel and column.
 */
.hud .row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: calc(var(--u) * 1.1);
  height: 1.34em;
  contain: size layout style;
}
.hud .lbl { font-size: 0.78em; font-weight: 500; letter-spacing: 0.07em; text-transform: uppercase; color: var(--label); white-space: nowrap; }
.hud .val { font-weight: 600; white-space: nowrap; text-align: right; min-width: 0; }
.hud .val.big { font-size: 1.75em; font-weight: 600; letter-spacing: 0.01em; }
.hud .sub { font-size: 0.8em; color: var(--label); white-space: nowrap; }
.hud .t-accent { color: var(--accent); }
.hud .t-good { color: var(--good); }
.hud .t-caution { color: var(--caution); }
.hud .t-warning { color: var(--warning); }
.hud .t-dim { color: var(--dim); }

.hud button {
  font: inherit;
  color: inherit;
  text-shadow: inherit;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--line);
  border-radius: calc(var(--u) * 0.6);
  padding: calc(var(--u) * 0.25) calc(var(--u) * 0.7);
  cursor: pointer;
  outline: none;
  transition: background-color 120ms, border-color 120ms, color 120ms;
}
.hud button:hover { background: rgba(120, 200, 255, 0.14); border-color: rgba(120, 200, 255, 0.45); }
.hud button:active { background: rgba(120, 200, 255, 0.24); }
.hud button[aria-disabled="true"] { opacity: 0.32; cursor: default; background: rgba(255, 255, 255, 0.03); border-color: var(--line); }
/* Only the interactive parts take pointer events (everything else lets the pointer through to the scene). */
.hud [data-hud-interactive] { pointer-events: auto; }
.hud .kbd .rg { position: relative; top: 0.32em; }
.hud .kbd {
  display: inline-block;
  min-width: 1.7em;
  padding: 0.05em 0.4em;
  border: 1px solid rgba(190, 210, 240, 0.4);
  border-bottom-width: 2px;
  border-radius: 0.3em;
  background: rgba(255, 255, 255, 0.07);
  font-size: 0.78em;
  font-weight: 600;
  text-align: center;
  color: var(--text);
  white-space: nowrap;
}
/* Key glyphs as printed on the cap: brackets and arrows enlarged, punctuation (. , / - and the like) larger still. */
.hud .kbd.glyph { font-size: 1.05em; font-weight: 700; padding: 0 0.35em; line-height: 1.12; }
.hud .kbd.glyph.punct { font-size: 1.3em; font-weight: 800; min-width: 1.45em; line-height: 0.92; }

/* Bars: a track and a fill scaled with transform (no layout per frame); the tone colours the whole fill. */
.hud .bar { position: relative; height: calc(var(--u) * 0.7); border-radius: calc(var(--u) * 0.35); background: rgba(150, 175, 210, 0.18); overflow: hidden; }
.hud .bar > i { position: absolute; inset: 0; transform-origin: 0 50%; background: var(--good); border-radius: inherit; }
.hud .bar.caution > i, .hud .bar.t-caution > i { background: var(--caution); }
.hud .bar.warning > i, .hud .bar.t-warning > i { background: var(--warning); }
.hud .bar.accent > i, .hud .bar.t-accent > i { background: var(--accent); }
.hud .bar.t-good > i { background: var(--good); }

/* Status light: a coloured dot and a word (chute envelope, recovery zone, the active stage). */
.hud .light { display: inline-flex; align-items: center; gap: 0.45em; font-weight: 700; letter-spacing: 0.06em; }
.hud .light::before { content: ''; width: 0.75em; height: 0.75em; border-radius: 50%; background: currentColor; box-shadow: 0 0 0.6em currentColor; }

/* ---------------------------------------------------------------- corners */
.hud .tc { position: absolute; left: 50%; top: var(--gap); transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: calc(var(--u) * 1); }
.hud .tr { position: absolute; right: var(--gap); top: var(--gap); display: flex; gap: calc(var(--u) * 0.8); align-items: center; }
.hud .lcol { position: absolute; left: var(--gap); top: var(--gap); width: var(--lcol); display: flex; flex-direction: column; gap: calc(var(--u) * 0.8); max-height: calc(100% - var(--gap) * 2); }
.hud .rcol { position: absolute; right: var(--gap); top: calc(var(--gap) + var(--u) * 4.4); width: var(--rcol); display: flex; flex-direction: column; gap: calc(var(--u) * 0.8); align-items: stretch; max-height: calc(100% - var(--u) * 8); }

/* ---------------------------------------------------------------- clock + warp */
.hud .clock .metrow { display: flex; align-items: center; justify-content: space-between; gap: calc(var(--u) * 0.8); height: 2.05em; contain: size layout style; }
.hud .clock .met { font-size: 1.32em; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap; }
/* The warp word (RAILS / PHYSICS) over the factor, right-aligned: the row holds "T+ 88d 88:88:88" and "×100k". */
.hud .clock .wf { display: flex; flex-direction: column; align-items: flex-end; justify-content: center; white-space: nowrap; line-height: 1.02; }
.hud .clock .wf .rails { font-size: 0.78em; letter-spacing: 0.09em; text-transform: uppercase; color: var(--label); font-weight: 600; }
.hud .clock .wf .rails:empty { display: none; }
.hud .clock .wf .factor { font-size: 1.05em; font-weight: 700; letter-spacing: 0.02em; }
.hud .clock .ut { font-size: 0.82em; color: var(--label); height: 1.25em; contain: size layout style; }
.hud .warp { display: flex; align-items: center; gap: calc(var(--u) * 0.6); margin-top: calc(var(--u) * 0.4); }
.hud .warp button { padding: 0 calc(var(--u) * 0.4); height: 1.45em; display: flex; align-items: center; }
.hud .warp button svg.step { width: 1em; height: 1em; display: block; }
/* Chevrons are polygons of one SVG (no clip-path per chevron: fewer paint chunks to layerize). */
.hud .chev { flex: 1; height: calc(var(--u) * 1.1); display: block; }
.hud .chev polygon { fill: rgba(150, 175, 210, 0.26); }
.hud .chev polygon.on { fill: var(--good); }
.hud .chev polygon.on.phys { fill: var(--caution); }
.hud .chev polygon.cap { fill: rgba(150, 175, 210, 0.08); }
.hud .warp-limit { font-size: 0.78em; color: var(--caution); margin-top: calc(var(--u) * 0.3); white-space: normal; line-height: 1.2; }

/* ---------------------------------------------------------------- altitude */
.hud .alt { width: calc(var(--u) * 24); text-align: center; padding: calc(var(--u) * 0.4) calc(var(--u) * 1); cursor: pointer; }
.hud .alt .ptitle { letter-spacing: 0.06em; }
.hud .alt .val.big { display: block; text-align: center; height: 1.22em; contain: size layout style; }
.hud .alt .vs { display: grid; grid-template-columns: auto auto; justify-content: center; align-items: center; column-gap: 0.9em; font-size: 0.84em; color: var(--label); height: 1.3em; contain: size layout style; }
.hud .alt .vs .sp { display: flex; align-items: center; gap: 0.35em; white-space: nowrap; }
.hud .alt .vs b { color: var(--text); font-weight: 600; }
.hud .alt .hsi { width: 0.95em; height: 0.95em; flex: none; color: var(--label); }
/* Vertical-speed trend icon: up / down chevron or a level bar (SVG, never a font glyph). */
.hud .vsi { width: 0.95em; height: 0.95em; flex: none; overflow: visible; }
.hud .vsi path { fill: none; stroke: currentColor; stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; }
.hud .vsi.up { color: var(--good); }
.hud .vsi.down { color: var(--caution); }
.hud .vsi.level { color: var(--label); }

/* ---------------------------------------------------------------- toasts */
.hud .notice .pill { background: var(--bg-strong); border: 1px solid rgba(85, 212, 255, 0.45); color: var(--accent); }
.hud .notice .spin { width: 0.9em; height: 0.9em; border-radius: 50%; border: 0.16em solid rgba(85, 212, 255, 0.3); border-top-color: var(--accent); animation: hud-spin 0.9s linear infinite; }
@keyframes hud-spin { to { transform: rotate(360deg); } }
.hud .toasts { display: flex; flex-direction: column; align-items: center; gap: calc(var(--u) * 0.6); }
.hud .toast {
  background: var(--bg-strong);
  border: 1px solid rgba(255, 187, 77, 0.45);
  border-left: calc(var(--u) * 0.45) solid var(--caution);
  border-radius: calc(var(--u) * 0.7);
  padding: calc(var(--u) * 0.6) calc(var(--u) * 1.4);
  font-weight: 500;
  max-width: calc(var(--u) * 60);
  text-align: center;
  box-shadow: var(--edge);
  animation: hud-toast-in 160ms ease-out;
}
.hud .toast.info { border-color: rgba(85, 212, 255, 0.4); border-left-color: var(--accent); }
.hud .toast .count { color: var(--caution); margin-left: 0.5em; font-weight: 700; }
.hud .toast.fade { opacity: 0; transition: opacity 400ms; }
@keyframes hud-toast-in { from { opacity: 0; transform: translateY(-30%); } to { opacity: 1; transform: none; } }

/* ---------------------------------------------------------------- top right */
.hud .pill { display: flex; align-items: center; gap: 0.5em; border-radius: 999px; padding: calc(var(--u) * 0.35) calc(var(--u) * 1.1); font-size: 0.84em; font-weight: 500; }
.hud .pill svg { width: 1.2em; height: 1.2em; flex: none; }
/* Keyboard capture: a labelled switch (track and knob), off by default; the state word after the label. */
.hud .kbcap { background: var(--bg-strong); color: var(--text); box-shadow: var(--edge); gap: 0.6em; padding-left: calc(var(--u) * 0.7); }
.hud .kbcap .sw { position: relative; flex: none; width: 2.1em; height: 1.15em; border-radius: 999px; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(170, 198, 235, 0.38); transition: background-color 150ms, border-color 150ms; }
.hud .kbcap .sw i { position: absolute; top: 50%; left: 0.12em; width: 0.8em; height: 0.8em; border-radius: 50%; background: #9fb0c6; transform: translateY(-50%); transition: transform 150ms, background-color 150ms; }
.hud .kbcap .kbl { font-weight: 500; letter-spacing: 0.02em; }
.hud .kbcap .kbs { min-width: 2.2em; font-size: 0.93em; font-weight: 700; letter-spacing: 0.08em; color: var(--label); }
.hud .kbcap.on .sw { background: rgba(95, 227, 154, 0.3); border-color: rgba(95, 227, 154, 0.85); }
.hud .kbcap.on .sw i { background: var(--good); transform: translate(1.04em, -50%); }
.hud .kbcap.on .kbs { color: var(--good); }
.hud .kbcap.nolock .sw { background: rgba(255, 187, 77, 0.25); border-color: rgba(255, 187, 77, 0.8); }
.hud .kbcap.nolock .sw i { background: var(--caution); }
.hud .kbcap.nolock .kbs { color: var(--caution); }
.hud .helpbtn { font-weight: 700; min-width: 2.2em; background: var(--bg-strong); box-shadow: var(--edge); }
.hud .warp button { background: var(--bg-strong); }

/* ---------------------------------------------------------------- stage stack */
/*
 * Top to bottom: the later stages as one list of one-line rows (number, icon, name, delta-v of engine stages),
 * the next stage as a full tile (key cap, delta-v / TWR / burn or what firing it does) and at the bottom the
 * stage that is burning now (green, live numbers). A stack taller than the column is clipped at its top.
 */
.hud .stagewrap { flex: 0 1 auto; min-height: 0; display: flex; flex-direction: column; }
.hud .stages { display: flex; flex-direction: column; justify-content: flex-end; gap: calc(var(--u) * 0.5); min-height: 0; overflow: hidden; }
.hud .stagewrap .more:not(.alone) + .stages { margin-top: -1px; }
.hud .stages > * { flex: none; }
/* The stage list's header strip: the title as a tab and the total delta-v at its right (glass, as the left column). */
.hud .stagewrap .more { display: flex; justify-content: space-between; align-items: baseline; gap: calc(var(--u) * 0.8); font-size: 0.8em; font-weight: 600; color: var(--text); white-space: nowrap; border: 1px solid rgba(120, 150, 190, 0.3); border-radius: calc(var(--u) * 0.8) calc(var(--u) * 0.8) 0 0; padding: calc(var(--u) * 0.3) calc(var(--u) * 0.9) calc(var(--u) * 0.36); box-shadow: var(--lit), var(--edge); background: rgba(16, 26, 38, 0.97); }
.hud .stagewrap .more > span:first-child { letter-spacing: 0.11em; text-transform: uppercase; }
.hud .stagewrap .more .tot { letter-spacing: 0.02em; }
.hud .stagewrap .more + .stages > .later:first-child { border-top: 0; border-radius: 0 0 calc(var(--u) * 0.8) calc(var(--u) * 0.8); }
.hud .stagewrap .more.alone { border-radius: calc(var(--u) * 0.8); }
.hud .later { padding: calc(var(--u) * 0.15) calc(var(--u) * 0.8) calc(var(--u) * 0.15) calc(var(--u) * 0.45); }
.hud .tile { display: flex; gap: calc(var(--u) * 0.7); align-items: center; padding: calc(var(--u) * 0.45) calc(var(--u) * 0.8) calc(var(--u) * 0.45) calc(var(--u) * 0.5); }
.hud .tile .sn { flex: none; width: 1.6em; text-align: center; font-size: 0.8em; font-weight: 700; color: var(--label); }
.hud .tile .ico { flex: none; width: calc(var(--u) * 3.1); height: calc(var(--u) * 3.1); border-radius: calc(var(--u) * 0.55); display: flex; align-items: center; justify-content: center; background: rgba(255, 255, 255, 0.06); color: #d2deec; }
.hud .tile .ico svg { width: 74%; height: 74%; }
.hud .tile .main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: calc(var(--u) * 0.12); }
.hud .tile .l1 { display: flex; align-items: center; gap: calc(var(--u) * 0.5); min-width: 0; }
.hud .tile .l1 .sn { width: auto; text-align: left; }
.hud .tile .name { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hud .tile .l2 { display: flex; align-items: baseline; gap: calc(var(--u) * 0.6); min-width: 0; height: 1.25em; }
.hud .tile .dv { flex: none; font-weight: 600; font-size: 0.86em; white-space: nowrap; }
.hud .tile .meta { flex: 1; min-width: 0; font-size: 0.8em; color: var(--label); white-space: pre; overflow: hidden; text-overflow: ellipsis; }
.hud .tile .bar.prop { height: calc(var(--u) * 0.4); margin-top: calc(var(--u) * 0.1); }
.hud .tile.next { border-color: rgba(85, 212, 255, 0.8); background: rgba(10, 33, 48, 0.97); box-shadow: 0 0 0 1px rgba(85, 212, 255, 0.25), var(--edge), 0 0 calc(var(--u) * 1.2) rgba(85, 212, 255, 0.16); cursor: pointer; }
.hud .tile.next .sn { color: var(--accent); }
.hud .tile.next .ico { background: rgba(85, 212, 255, 0.2); color: var(--accent); }
.hud .tile.next:hover { background: rgba(14, 44, 64, 0.98); }
.hud .tile .hint { flex: none; font-size: 0.78em; font-weight: 700; color: var(--accent); }
.hud .tile .hint .kbd { font-size: 1em; }
.hud .tile.active { border-color: rgba(95, 227, 154, 0.7); background: rgba(9, 30, 22, 0.97); box-shadow: 0 0 0 1px rgba(95, 227, 154, 0.2), var(--edge); }
.hud .tile.active .sn { color: var(--good); }
.hud .tile.active .ico { background: rgba(95, 227, 154, 0.18); color: var(--good); }
/* The name of what burns is never cut: a long one ("Heron descent stage") sends the ACTIVE tag to a line of its own. */
/* The next tile never cuts what Space will do: its name and its action words wrap (one tile may grow a line). */
.hud .tile.next .name { white-space: normal; overflow: visible; text-overflow: clip; line-height: 1.2; }
.hud .tile.next .l2 { height: auto; min-height: 1.25em; }
.hud .tile.next .meta { white-space: pre-wrap; overflow: visible; text-overflow: clip; line-height: 1.25; }
/* The active tile: green edge, icon and number say active (no badge competing with the name). */
.hud .tile.active .name { white-space: normal; overflow: visible; text-overflow: clip; line-height: 1.2; }
/* Locked: an amber, dimmed tile with a padlock plate and the reason at label size. */
.hud .tile.next.locked { border-color: rgba(255, 187, 77, 0.85); background: repeating-linear-gradient(135deg, rgba(52, 36, 10, 0.97) 0, rgba(52, 36, 10, 0.97) calc(var(--u) * 0.9), rgba(40, 28, 8, 0.97) calc(var(--u) * 0.9), rgba(40, 28, 8, 0.97) calc(var(--u) * 1.8)); box-shadow: 0 0 0 1px rgba(255, 187, 77, 0.25), var(--edge); cursor: not-allowed; }
.hud .tile.next.locked .sn { color: var(--caution); }
.hud .tile.next.locked .ico { background: rgba(255, 187, 77, 0.22); color: var(--caution); }
.hud .tile.next.locked .name { color: #e9dcc4; }
.hud .tile.next.locked .lockline { display: flex; align-items: center; gap: 0.45em; font-size: 0.8em; color: var(--caution); white-space: nowrap; }
.hud .tile.next.locked .lockline b { font-weight: 700; letter-spacing: 0.1em; }
.hud .tile.next.locked .lockline span { color: #f1dcb5; }
.hud .tile.compact { gap: calc(var(--u) * 0.6); height: calc(var(--u) * 1.8); padding: 0; line-height: 1.12; }
.hud .tile.compact + .tile.compact { border-top: 1px solid rgba(170, 198, 235, 0.11); }
.hud .tile.compact .sn { font-size: 0.78em; }
.hud .tile.compact .ico { width: calc(var(--u) * 1.65); height: calc(var(--u) * 1.65); background: none; color: #c3d0df; }
.hud .tile.compact .ico svg { width: 94%; height: 94%; }
.hud .tile.compact .name { font-size: 0.86em; font-weight: 500; color: #dbe4ef; }
.hud .tile.compact .dv { font-size: 0.8em; font-weight: 500; color: var(--label); }

/* ---------------------------------------------------------------- resources */
.hud .res { flex: none; }
.hud .res .rrow { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: 1.3em calc(var(--u) * 0.45); column-gap: calc(var(--u) * 0.7); row-gap: calc(var(--u) * 0.12); align-items: center; font-size: 0.86em; height: calc(1.3em + var(--u) * 0.75); contain: size layout style; }
.hud .res .rrow .rn { color: var(--text); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hud .res .rrow .rp { text-align: right; font-weight: 600; }
.hud .res .rrow .bar { grid-column: 1 / -1; height: calc(var(--u) * 0.45); }
/* The groups not in use, all full, on one line. */
.hud .res .full { margin-top: calc(var(--u) * 0.4); padding-top: calc(var(--u) * 0.3); border-top: 1px solid rgba(170, 198, 235, 0.12); font-size: 0.8em; color: var(--label); line-height: 1.3; }
.hud .res .full.only { margin-top: 0; padding-top: 0; border-top: 0; }
.hud .res .full b { color: var(--good); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; margin-right: 0.15em; }

/* ---------------------------------------------------------------- bottom cluster */
/*
 * One instrument: a gunmetal housing across the bottom carrying the SAS controls (left), the navball (centre) and
 * the tape gauges (right), symmetric about the ball, so the ball sits on the screen's centre line. The ball's
 * read-outs are black-glass windows set into the instrument: speed and heading on the bezel's top arc, pitch at 9
 * and roll at 3 o'clock over the bezel's rim. The maneuver readout stands on the housing right of the ball.
 */
.hud .bottom {
  --ball: calc(var(--u) * 24.5);
  --side: calc(var(--u) * 17);
  --win: calc(var(--u) * 5.2);
  --hh: calc(var(--u) * 14);
  position: absolute; left: 50%; bottom: calc(var(--u) * 0.9); transform: translateX(-50%);
  display: grid; grid-template-columns: var(--side) var(--win) var(--ball) var(--win) var(--side); grid-template-rows: auto; column-gap: calc(var(--u) * 0.45); align-items: end;
}
.hud .bottom > * { grid-row: 1; }
.hud .bottom > .housing { grid-column: 1 / -1; align-self: end; height: var(--hh); border-radius: calc(var(--u) * 1.3); margin: 0 calc(var(--u) * -0.5); }
.hud .bottom > .bl { grid-column: 1; z-index: 1; }
.hud .bottom > .pitch { grid-column: 2; justify-self: end; margin-right: calc(var(--u) * -1.4); }
.hud .bottom > .bc { grid-column: 3; z-index: 2; }
.hud .bottom > .roll { grid-column: 4; justify-self: start; margin-left: calc(var(--u) * -1.4); }
.hud .bottom > .br { grid-column: 5; z-index: 1; }
/* The SAS controls and the gauges are regions of the housing (no plates of their own). */
.hud .bottom .sas, .hud .bottom .gauges { background: none; border: 0; box-shadow: none; border-radius: 0; height: var(--hh); }
.hud .sas { display: flex; flex-direction: column; justify-content: center; gap: calc(var(--u) * 0.45); padding: calc(var(--u) * 0.55) calc(var(--u) * 0.2) calc(var(--u) * 0.45) calc(var(--u) * 0.3); }
.hud .toggles { display: grid; grid-template-columns: repeat(3, 1fr); gap: calc(var(--u) * 0.35); }
.hud .toggles button { font-size: 0.76em; font-weight: 700; letter-spacing: 0.03em; padding: calc(var(--u) * 0.18) 0; color: var(--label); }
.hud .toggles button.on { color: #04121a; background: var(--accent); border-color: var(--accent); text-shadow: none; }
.hud .toggles button.on.sasbtn { background: var(--good); border-color: var(--good); }
.hud .toggles button.abort { color: var(--warning); border-color: rgba(255, 98, 98, 0.45); }
/* SAS mode buttons: the marker icon fills the button (about 18 px at 720p); the key is in the tooltip and key help. */
.hud .modes { display: grid; grid-template-columns: repeat(4, 1fr); gap: calc(var(--u) * 0.35); }
.hud .modes button { height: calc(var(--u) * 3.05); padding: 8% 10%; display: flex; align-items: center; justify-content: center; }
.hud .modes button svg { width: 100%; height: 100%; }
.hud .modes button.on { border-color: rgba(95, 227, 154, 0.95); background: rgba(95, 227, 154, 0.2); box-shadow: inset 0 0 0 1px rgba(95, 227, 154, 0.6); }
.hud .modecap { font-size: 0.78em; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; color: var(--label); text-align: center; white-space: nowrap; }
.hud .modecap b { color: var(--good); font-weight: 700; }

.hud .nbwrap { display: flex; flex-direction: column; align-items: center; }
/* Speed (in the navball's frame, its mode named) and heading: one window on the bezel's top arc. */
.hud .bottom .speed { position: relative; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: calc(var(--u) * 0.8); width: calc(var(--u) * 31); height: calc(var(--u) * 3.05); margin-bottom: calc(var(--u) * -0.35); padding: 0 calc(var(--u) * 0.9); border-radius: calc(var(--u) * 0.7); cursor: pointer; contain: size layout style; }
.hud .speed .spd { display: flex; align-items: baseline; gap: 0.5em; white-space: nowrap; }
.hud .speed .mode { color: var(--accent); font-size: 0.78em; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
.hud .speed .sv { font-size: 1.32em; font-weight: 600; letter-spacing: 0.01em; }
.hud .speed .hd { display: flex; align-items: baseline; gap: 0.4em; white-space: nowrap; padding-left: calc(var(--u) * 0.8); border-left: 1px solid rgba(170, 198, 235, 0.18); }
.hud .speed .hd b { font-size: 1.05em; font-weight: 700; }
/* Pitch (9 o'clock) and roll (3 o'clock): two-line windows over the bezel's rim at the ball's centre height. */
.hud .bottom .prw { z-index: 3; align-self: end; display: flex; flex-direction: column; align-items: center; justify-content: center; width: calc(var(--win) + var(--u) * 1.4); height: calc(var(--u) * 3.9); margin-bottom: calc(var(--ball) / 2 - var(--u) * 1.95); border-radius: calc(var(--u) * 0.6); line-height: 1.1; contain: size layout style; }
.hud .prw .lbl { letter-spacing: 0.06em; }
.hud .prw b { font-weight: 600; font-size: 0.92em; }
/*
 * The navball instrument: the WebGPU ball (ray-cast sphere, shading and glass in the shader) and over it a
 * static 2-D canvas with the machined bezel - recessed gap, bevel lit from above, the roll scale and the top
 * index - redrawn only when the element is resized. The bezel canvas is larger than the ball's box so its soft
 * drop shadow fades out inside it.
 */
.hud .ball { position: relative; width: calc(var(--u) * 24.5); height: calc(var(--u) * 24.5); contain: size layout style; }
.hud .ball canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.hud .ball canvas.bezel { inset: -14%; width: 128%; height: 128%; }

/*
 * Tape gauges. The zone colours are fixed to the scale (G: green to 6 g, amber to the 10 g limit, red above;
 * the sim's dose threshold and recovery level) and only revealed by the fill: an overflow-hidden window
 * translated down by (1 - f) with the scale-fixed colour layer translated back up (two composited transforms,
 * no layout or paint per frame). The fill has a flat top with a thin lighter line. The crew's g-dose is a third,
 * narrower tape beside the g tube (amber, red from two thirds of the fatal limit), always there. The gauges share one grid,
 * so tops, bottoms and values line up.
 */
.hud .gauges { display: grid; grid-template-columns: auto auto auto; justify-content: center; align-content: center; column-gap: calc(var(--u) * 0.75); row-gap: calc(var(--u) * 0.3); justify-items: center; padding: calc(var(--u) * 0.45) calc(var(--u) * 0.3) calc(var(--u) * 0.45) calc(var(--u) * 0.2); }
.hud .gauge { display: contents; }
.hud .gauge.thr > * { grid-column: 1; }
.hud .gauge.g > * { grid-column: 2; }
.hud .gauge.dose > * { grid-column: 3; }
.hud .gauge .gv { grid-row: 1; font-weight: 700; font-size: 0.9em; display: block; width: calc(var(--u) * 5.4); text-align: center; white-space: nowrap; height: 1.25em; contain: size layout style; }
.hud .gauge.thr .gv { width: calc(var(--u) * 4.6); }
.hud .gauge.dose .gv { width: calc(var(--u) * 4.2); }
.hud .gauge.dose .nums { display: none; }
.hud .gauge.dose.nil .gv { color: var(--label); font-weight: 500; }
.hud .gauge .scale { grid-row: 2; position: relative; display: flex; gap: calc(var(--u) * 0.45); align-items: stretch; margin-top: calc(var(--u) * 0.35); }
.hud .gauge .nums { position: relative; width: calc(var(--u) * 2.6); height: calc(var(--u) * 7.8); font-size: 0.78em; font-weight: 600; color: var(--label); }
.hud .gauge .nums span { position: absolute; right: 0; transform: translateY(50%); line-height: 1; }
.hud .gauge .tube { position: relative; width: calc(var(--u) * 2.2); height: calc(var(--u) * 7.8); border-radius: calc(var(--u) * 0.3); background: rgba(6, 9, 14, 0.94); border: 1px solid var(--line); overflow: hidden; box-shadow: inset 0 calc(var(--u) * 0.25) calc(var(--u) * 0.6) rgba(0, 0, 0, 0.6); }
.hud .gauge .track { position: absolute; inset: 0; opacity: 0.2; }
.hud .gauge .win { position: absolute; inset: 0; overflow: hidden; will-change: transform; transform: translateY(100%); }
.hud .gauge .win > i { position: absolute; inset: 0; will-change: transform; transform: translateY(-100%); }
.hud .gauge .win::after { content: ''; position: absolute; left: 0; right: 0; top: 0; height: max(1px, calc(var(--u) * 0.15)); background: rgba(255, 255, 255, 0.4); }
.hud .gauge.thr .track, .hud .gauge.thr .win > i { background: linear-gradient(to top, #1f9fe6, #6fdcff); }
.hud .gauge.g .track, .hud .gauge.g .win > i { background: linear-gradient(to top, #3cc97f 0%, #66e3a0 50%, #ffbb4d 50%, #ffc766 83.333%, #ff5a5a 83.333%, #ff7a7a 100%); }
.hud .gauge.dose .track, .hud .gauge.dose .win > i { background: linear-gradient(to top, #e8a23f 0%, #ffc766 66.667%, #ff5a5a 66.667%, #ff7a7a 100%); }
.hud .gauge .ticks { position: absolute; inset: 0; background: repeating-linear-gradient(to top, transparent 0, transparent calc(100% / var(--n) - 1px), rgba(255,255,255,0.24) calc(100% / var(--n) - 1px), rgba(255,255,255,0.24) calc(100% / var(--n))); }
.hud .gauge .limit { position: absolute; left: -1px; right: -1px; height: 2px; background: #ff5a5a; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6); }
.hud .gauge .gl { grid-row: 3; margin-top: calc(var(--u) * 0.15); font-size: 0.78em; letter-spacing: 0.04em; color: var(--label); font-weight: 600; white-space: nowrap; }

.hud .bottom > .node { position: absolute; left: calc(50% + var(--u) * 15.3); bottom: calc(var(--hh) + var(--u) * 0.8); width: calc(var(--u) * 21); }
.hud .node .nwhen { display: inline-flex; align-items: baseline; gap: 0.45em; white-space: nowrap; }
.hud .node .nword { font-size: 1em; font-weight: 700; letter-spacing: 0.08em; color: var(--label); }
.hud .node .nstart { font-size: 1.15em; font-variant-numeric: tabular-nums; }
.hud .node.imminent .nstart { color: var(--caution); }
.hud .node.imminent { border-color: var(--caution); --st: var(--caution); }
/* The pulse animates the opacity of a glow layer, which runs on the compositor (no paint per frame). */
.hud .node.imminent::after { content: ''; position: absolute; inset: -1px; border-radius: inherit; box-shadow: 0 0 calc(var(--u) * 1.6) rgba(255, 187, 77, 0.55); opacity: 0; animation: hud-pulse 1s ease-in-out infinite; pointer-events: none; }
@keyframes hud-pulse { 50% { opacity: 1; } }

/* ---------------------------------------------------------------- left panels */
.hud .orbit .apsis { display: grid; grid-template-columns: auto 1fr auto; gap: calc(var(--u) * 0.8); align-items: baseline; height: 1.34em; contain: size layout style; }
.hud .orbit .apsis .lbl { letter-spacing: 0.04em; }
.hud .orbit .apsis .sub { text-align: right; min-width: 4.2em; font-size: 0.78em; }
/* A periapsis below the surface (long value, no time): both rows put the time after the label and the value at
   the panel's edge, so Ap and Pe keep one right-aligned value column. */
.hud .orbit.wide .apsis { grid-template-columns: auto auto 1fr; }
.hud .orbit.wide .apsis > * { grid-row: 1; }
.hud .orbit.wide .apsis .lbl { grid-column: 1; }
.hud .orbit.wide .apsis .sub { grid-column: 2; text-align: left; min-width: 0; }
.hud .orbit.wide .apsis .val { grid-column: 3; }
.hud .ptitle .pright { display: flex; align-items: baseline; gap: 0.6em; }
.hud .ptitle .tag { font-weight: 700; letter-spacing: 0.08em; }
/* Atmosphere: three cells on one strip (in its own panel, under the orbit rows in an ascent, or in the entry panel). */
.hud .atmrows { display: grid; grid-template-columns: 1.25fr 1fr 1fr; column-gap: calc(var(--u) * 0.8); }
.hud .atmrows .cell { display: flex; flex-direction: column; min-width: 0; height: 2.55em; contain: size layout style; }
.hud .atmrows .cell .val { text-align: left; font-size: 0.96em; }
.hud .atmrows .cell + .cell { border-left: 1px solid rgba(170, 198, 235, 0.14); padding-left: calc(var(--u) * 0.8); }
.hud .atmrows.sepd { border-top: 1px solid var(--line); margin-top: calc(var(--u) * 0.35); padding-top: calc(var(--u) * 0.3); }
.hud .lt .ptitle .pname { white-space: nowrap; min-width: 0; }
.hud .lt .ltline { font-size: 0.86em; font-weight: 600; color: var(--label); height: 1.3em; contain: size layout style; }
.hud .lt .rows .row { gap: calc(var(--u) * 0.6); }
.hud .lt .rows .val { font-size: 0.92em; }
.hud .lt .rows .lbl { letter-spacing: 0.01em; }
.hud .lt .pred { margin-top: calc(var(--u) * 0.3); padding-top: calc(var(--u) * 0.35); border-top: 1px solid var(--line); height: calc(1.34em + var(--u) * 0.35 + 1px); }
.hud .lt .zone { margin-top: calc(var(--u) * 0.45); padding: calc(var(--u) * 0.3) calc(var(--u) * 0.8); border-radius: calc(var(--u) * 0.6); display: flex; align-items: center; justify-content: space-between; gap: calc(var(--u) * 0.6); font-size: 0.9em; }
.hud .lt .zone.t-good { background: rgba(95, 227, 154, 0.14); border: 1px solid rgba(95, 227, 154, 0.55); }
.hud .lt .zone.t-caution { background: rgba(255, 187, 77, 0.14); border: 1px solid rgba(255, 187, 77, 0.55); }
.hud .lt .zone .light { white-space: nowrap; }
.hud .lt .zone .sub { color: var(--label); font-weight: 500; font-size: 0.88em; white-space: nowrap; }
.hud .entry .lift { font-weight: 700; color: #7dffa8; letter-spacing: 0.08em; }
.hud .entry .sep { border-top: 1px solid var(--line); margin: calc(var(--u) * 0.3) 0 calc(var(--u) * 0.15); }
/* A label, a bar coloured by the zone of its reading, and the reading (heat shield, skin temperature). */
.hud .brow { display: grid; grid-template-columns: auto minmax(0, 1fr) 2.9em; gap: calc(var(--u) * 0.8); align-items: center; height: 1.34em; contain: size layout style; }
.hud .brow .bar { height: calc(var(--u) * 0.6); }
.hud .brow .bv { font-weight: 600; text-align: right; white-space: nowrap; }
.hud .pad .padhint { font-size: 0.8em; color: var(--label); line-height: 1.25; margin: calc(var(--u) * 0.1) 0 calc(var(--u) * 0.25); }
.hud .pad .ptitle .pname.none { color: var(--label); font-size: 1em; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; }
.hud .pad .suggest { display: flex; flex-wrap: wrap; gap: calc(var(--u) * 0.4); margin-bottom: calc(var(--u) * 0.3); }
.hud .pad .suggest button { font-size: 0.92em; font-weight: 600; color: var(--accent); border-color: rgba(85, 212, 255, 0.45); }
.hud .pad .targets { display: flex; flex-wrap: wrap; gap: calc(var(--u) * 0.4); }
.hud .pad .targets button { font-size: 1.15em; letter-spacing: 0.03em; text-transform: none; padding: 0 calc(var(--u) * 0.7); color: var(--text); display: inline-flex; align-items: baseline; gap: 0.35em; }
/* "Target Moon": the verb in the label style, so the chip reads as an action. */
.hud .pad .targets button .pfx { font-size: 0.86em; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--label); }
.hud .pad .targets button.on .pfx { color: #ffc6f0; }
.hud .pad .targets button.on { background: rgba(255, 91, 214, 0.24); border-color: rgba(255, 91, 214, 0.8); }

/* ---------------------------------------------------------------- centre */
/*
 * Mission failed: a modal outcome. The flight panels are powered down - their content dimmed and desaturated, the
 * plates as opaque as ever - and inert (no pointer events) behind it; the clock stays readable; the banner offers
 * the app shell's next steps.
 */
.hud.failed-state .lcol > :not(.clock), .hud.failed-state .rcol, .hud.failed-state .bottom, .hud.failed-state .tc, .hud.failed-state .tr { filter: brightness(0.42) saturate(0.25); }
.hud.failed-state .lcol [data-hud-interactive], .hud.failed-state .rcol [data-hud-interactive], .hud.failed-state .bottom [data-hud-interactive], .hud.failed-state .tc [data-hud-interactive], .hud.failed-state .tr [data-hud-interactive] { pointer-events: none; }
.hud.failed-state .clock .warp { filter: brightness(0.42) saturate(0.25); }
.hud.failed-state .clock .warp button { pointer-events: none; }
.hud .failed { position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%); text-align: center; width: calc(var(--u) * 62); background: linear-gradient(180deg, rgba(46, 8, 10, 0.98), rgba(26, 5, 7, 0.98)); border: 1px solid rgba(255, 98, 98, 0.75); border-top: calc(var(--u) * 0.45) solid var(--warning); border-radius: calc(var(--u) * 1.2); padding: calc(var(--u) * 2.2) calc(var(--u) * 4) calc(var(--u) * 2.4); box-shadow: var(--edge), 0 0 calc(var(--u) * 6) rgba(255, 60, 60, 0.25), 0 calc(var(--u) * 2) calc(var(--u) * 8) rgba(0, 0, 0, 0.6); }
.hud .failed h2 { margin: 0; font-size: 2.4em; letter-spacing: 0.18em; color: var(--warning); font-weight: 700; }
.hud .failed p { margin: calc(var(--u) * 0.9) 0 0; font-size: 1.05em; line-height: 1.35; color: #ffd5d5; }
.hud .failed .actions { display: flex; justify-content: center; gap: calc(var(--u) * 1.2); margin-top: calc(var(--u) * 2); }
.hud .failed .actions button { font-size: 1em; padding: calc(var(--u) * 0.55) calc(var(--u) * 1.8); background: rgba(255, 255, 255, 0.08); border-color: rgba(255, 190, 190, 0.45); color: #fff1f1; display: inline-flex; align-items: center; gap: 0.6em; }
.hud .failed .actions button:first-child { background: rgba(255, 98, 98, 0.22); border-color: rgba(255, 120, 120, 0.85); }
.hud .failed .actions button:hover { background: rgba(255, 120, 120, 0.32); }
.hud .failed .note { margin-top: calc(var(--u) * 1.4); font-size: 0.86em; color: #f0b9b9; letter-spacing: 0.06em; text-transform: uppercase; }

/* ---------------------------------------------------------------- key help */
/* A modal sheet: opaque, and the flight panels are taken off screen while it is open (nothing ghosts through). */
.hud.help-open .lcol, .hud.help-open .rcol, .hud.help-open .bottom, .hud.help-open .tc, .hud.help-open .tr, .hud.help-open .failed { visibility: hidden; }
.hud .help { position: absolute; inset: 0; background: rgba(2, 4, 8, 0.72); display: flex; align-items: center; justify-content: center; }
.hud .help .sheet { background: #0c1219; border: 1px solid var(--line); border-radius: calc(var(--u) * 1.4); padding: calc(var(--u) * 2.4) calc(var(--u) * 3); width: min(calc(var(--u) * 150), 94%); max-height: 92%; overflow: hidden; box-shadow: var(--lit), var(--edge), 0 calc(var(--u) * 2) calc(var(--u) * 8) rgba(0, 0, 0, 0.6); }
.hud .help .head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: calc(var(--u) * 1.4); }
.hud .help h2 { margin: 0; font-size: 1.45em; letter-spacing: 0.04em; font-weight: 600; }
.hud .help .note { color: var(--label); font-size: 0.82em; margin-top: calc(var(--u) * 0.3); }
/* Three columns of groups, balanced by height (balanceColumns in hud.ts). */
.hud .help .cols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); column-gap: calc(var(--u) * 3.2); align-items: start; }
.hud .help .group { margin-bottom: calc(var(--u) * 1.4); }
.hud .help .group h3 { margin: 0 0 calc(var(--u) * 0.5); font-size: 0.78em; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); font-weight: 600; }
.hud .help .item { display: flex; justify-content: space-between; align-items: center; gap: calc(var(--u) * 1); padding: calc(var(--u) * 0.18) 0; font-size: 0.86em; border-bottom: 1px solid rgba(160, 190, 230, 0.08); }
.hud .help .item .keys { display: flex; gap: 0.3em; flex-wrap: wrap; justify-content: flex-end; }
.hud .help .item .kbd { font-size: 0.9em; }
.hud .help .item .kbd.glyph { font-size: 1.12em; }
.hud .help .item .kbd.glyph.punct { font-size: 1.4em; }
.hud .help .item .kbd.locked { border-color: rgba(255, 187, 77, 0.6); color: #ffe2b0; }
`;
