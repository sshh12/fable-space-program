/**
 * HUD stylesheet. Every size derives from --u = min(1vh, 0.5625vw) (one hundredth of the height of a 16:9
 * frame), so the layout is identical from 1280 x 720 to 3840 x 2160 and never overflows narrower windows.
 *
 * The frame belongs to the scene: two narrow side columns (26u / 26.5u), a slim bottom cluster and one altimeter plate
 * at the top keep the HUD within a fifth of a 16:9 frame (asserted on the screenshots). Panels are opaque plates
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
  --lcol: calc(var(--u) * 26);
  --rcol: calc(var(--u) * 26.5);
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
/* Bracket keys keep their glyph, enlarged and centred; other punctuation keys are named ("Period"). */
.hud .kbd.glyph { font-size: 1.05em; font-weight: 700; padding: 0 0.35em; line-height: 1.12; }

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
.hud .clock .metrow { display: flex; align-items: baseline; justify-content: space-between; gap: calc(var(--u) * 0.8); height: 1.66em; contain: size layout style; }
.hud .clock .met { font-size: 1.32em; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap; }
.hud .clock .wf { display: flex; align-items: baseline; gap: 0.45em; white-space: nowrap; }
.hud .clock .wf .rails { font-size: 0.78em; letter-spacing: 0.09em; text-transform: uppercase; color: var(--label); font-weight: 600; }
.hud .clock .wf .factor { font-size: 1.05em; font-weight: 700; letter-spacing: 0.02em; }
.hud .clock .ut { font-size: 0.82em; color: var(--label); height: 1.25em; contain: size layout style; }
.hud .warp { display: flex; align-items: center; gap: calc(var(--u) * 0.6); margin-top: calc(var(--u) * 0.4); }
.hud .warp button { padding: 0 calc(var(--u) * 0.55); line-height: 1.3; font-weight: 700; }
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
.hud .kbcap { background: rgba(58, 38, 8, 0.96); border-color: rgba(255, 187, 77, 0.6); color: #ffe2b0; box-shadow: var(--edge); }
.hud .kbcap b { color: var(--caution); font-weight: 700; }
.hud .kbok { background: var(--bg-strong); color: var(--good); border: 1px solid var(--line); box-shadow: var(--edge); }
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
.hud .stages > * { flex: none; }
.hud .stagewrap .more { align-self: flex-end; font-size: 0.8em; font-weight: 600; color: var(--text); letter-spacing: 0.03em; white-space: nowrap; background: var(--bg-strong); border: 1px solid var(--line); border-radius: calc(var(--u) * 0.5); padding: calc(var(--u) * 0.1) calc(var(--u) * 0.7); margin-bottom: calc(var(--u) * 0.5); box-shadow: var(--edge); }
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
.hud .tile .hint .kbd { font-size: 0.95em; }
.hud .tile.active { border-color: rgba(95, 227, 154, 0.7); background: rgba(9, 30, 22, 0.97); box-shadow: 0 0 0 1px rgba(95, 227, 154, 0.2), var(--edge); }
.hud .tile.active .sn { color: var(--good); }
.hud .tile.active .ico { background: rgba(95, 227, 154, 0.18); color: var(--good); }
.hud .tile.active .act { flex: none; font-size: 0.74em; font-weight: 700; color: var(--good); letter-spacing: 0.06em; border: 1px solid rgba(95, 227, 154, 0.55); border-radius: 0.3em; padding: 0 0.35em; line-height: 1.35; }
/* Locked: an amber, dimmed tile with a padlock plate and the reason at label size. */
.hud .tile.next.locked { border-color: rgba(255, 187, 77, 0.85); background: repeating-linear-gradient(135deg, rgba(52, 36, 10, 0.97) 0, rgba(52, 36, 10, 0.97) calc(var(--u) * 0.9), rgba(40, 28, 8, 0.97) calc(var(--u) * 0.9), rgba(40, 28, 8, 0.97) calc(var(--u) * 1.8)); box-shadow: 0 0 0 1px rgba(255, 187, 77, 0.25), var(--edge); cursor: not-allowed; }
.hud .tile.next.locked .sn { color: var(--caution); }
.hud .tile.next.locked .ico { background: rgba(255, 187, 77, 0.22); color: var(--caution); }
.hud .tile.next.locked .name { color: #e9dcc4; }
.hud .tile.next.locked .lockline { display: flex; align-items: center; gap: 0.45em; font-size: 0.8em; color: var(--caution); white-space: nowrap; }
.hud .tile.next.locked .lockline b { font-weight: 700; letter-spacing: 0.1em; }
.hud .tile.next.locked .lockline span { color: #f1dcb5; }
.hud .tile.compact { gap: calc(var(--u) * 0.6); height: calc(var(--u) * 1.8); padding: 0; }
.hud .tile.compact + .tile.compact { border-top: 1px solid rgba(170, 198, 235, 0.11); }
.hud .tile.compact .sn { font-size: 0.78em; }
.hud .tile.compact .ico { width: calc(var(--u) * 1.8); height: calc(var(--u) * 1.8); background: none; color: #c3d0df; }
.hud .tile.compact .ico svg { width: 94%; height: 94%; }
.hud .tile.compact .name { font-size: 0.86em; font-weight: 500; color: #dbe4ef; }
.hud .tile.compact .dv { font-size: 0.8em; font-weight: 500; color: var(--label); }

/* ---------------------------------------------------------------- resources */
.hud .res { flex: none; }
.hud .res .rrow { display: grid; grid-template-columns: minmax(0, 1fr) calc(var(--u) * 6) 3em; gap: calc(var(--u) * 0.7); align-items: center; font-size: 0.86em; height: 1.4em; contain: size layout style; }
.hud .res .rrow .rn { color: var(--text); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hud .res .rrow .rp { text-align: right; font-weight: 600; }
/* The groups not in use, all full, on one line. */
.hud .res .full { margin-top: calc(var(--u) * 0.4); padding-top: calc(var(--u) * 0.3); border-top: 1px solid rgba(170, 198, 235, 0.12); font-size: 0.8em; color: var(--label); line-height: 1.3; }
.hud .res .full.only { margin-top: 0; padding-top: 0; border-top: 0; }
.hud .res .full b { color: var(--good); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; margin-right: 0.15em; }

/* ---------------------------------------------------------------- bottom cluster */
/*
 * Three columns, the navball alone in the middle one: the side columns are equal (1fr), so the ball sits on the
 * screen's centre line whatever the SAS panel, the gauges or a maneuver panel add on either side.
 */
.hud .bottom { position: absolute; left: var(--gap); right: var(--gap); bottom: calc(var(--u) * 0.9); display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: end; column-gap: calc(var(--u) * 1.1); }
.hud .bottom > .bl { grid-column: 1; justify-self: end; }
.hud .bottom > .bc { grid-column: 2; }
.hud .bottom > .br { grid-column: 3; justify-self: start; display: flex; flex-direction: column; gap: calc(var(--u) * 0.8); align-items: flex-start; }
.hud .sas { width: calc(var(--u) * 15.5); display: flex; flex-direction: column; gap: calc(var(--u) * 0.45); padding: calc(var(--u) * 0.6) calc(var(--u) * 0.8); }
.hud .toggles { display: grid; grid-template-columns: 1fr 1fr; gap: calc(var(--u) * 0.4); }
.hud .toggles button { font-size: 0.78em; font-weight: 700; letter-spacing: 0.07em; padding: calc(var(--u) * 0.2) 0; color: var(--label); }
.hud .toggles button.on { color: #04121a; background: var(--accent); border-color: var(--accent); text-shadow: none; }
.hud .toggles button.on.sasbtn { background: var(--good); border-color: var(--good); }
.hud .toggles button.abort { color: var(--warning); border-color: rgba(255, 98, 98, 0.45); }
.hud .modes { display: grid; grid-template-columns: repeat(4, 1fr); gap: calc(var(--u) * 0.4); }
/* The key digit owns the top-left corner: the icon box is inset away from it, so the two never touch. */
.hud .modes button { aspect-ratio: 1; padding: 27% 7% 7% 27%; display: flex; align-items: center; justify-content: center; position: relative; }
.hud .modes button svg { width: 100%; height: 100%; }
.hud .modes button.on { border-color: rgba(95, 227, 154, 0.95); background: rgba(95, 227, 154, 0.2); box-shadow: inset 0 0 0 1px rgba(95, 227, 154, 0.6); }
.hud .modes button .key { position: absolute; left: 0.3em; top: 0.12em; font-size: 0.76em; font-weight: 700; line-height: 1.2; color: var(--label); }
.hud .modes button.on .key { color: var(--good); }
.hud .modecap { font-size: 0.78em; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; color: var(--label); text-align: center; white-space: nowrap; }
.hud .modecap b { color: var(--good); font-weight: 700; }

.hud .nbwrap { display: flex; flex-direction: column; align-items: center; gap: calc(var(--u) * 0.4); }
.hud .speed { text-align: center; padding: calc(var(--u) * 0.3) calc(var(--u) * 1) calc(var(--u) * 0.35); cursor: pointer; width: calc(var(--u) * 17.5); }
.hud .speed .ptitle { margin-bottom: 0; }
.hud .speed .val.big { font-size: 1.45em; display: block; text-align: center; height: 1.2em; contain: size layout style; }
.hud .speed .mode { color: var(--accent); }
/*
 * The ball's read-outs: pitch, heading (over the bezel's top index) and roll in fixed-width windows on one row
 * above the instrument, clear of the bezel and never changing width with the value.
 */
.hud .nbchips { position: relative; z-index: 1; display: grid; grid-template-columns: 1fr auto 1fr; align-items: end; column-gap: calc(var(--u) * 0.6); width: calc(var(--u) * 29); margin-bottom: calc(var(--u) * -0.3); }
.hud .nbchips > div { background: var(--bg-strong); border: 1px solid var(--line); border-radius: calc(var(--u) * 0.5); box-shadow: var(--edge); height: 1.55em; display: flex; align-items: center; contain: size layout style; }
.hud .nbchips .pr { width: calc(var(--u) * 10.9); justify-content: space-between; gap: 0.4em; padding: 0 calc(var(--u) * 0.55); font-size: 0.77em; }
.hud .nbchips .pr .lbl { font-size: 0.92em; }
.hud .nbchips .pr b { font-weight: 600; }
.hud .nbchips .pitch { justify-self: start; }
.hud .nbchips .roll { justify-self: end; }
.hud .nbchips .hdg { justify-content: center; width: calc(var(--u) * 6.4); font-weight: 700; font-size: 0.92em; }
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
 * no layout or paint per frame). The fill has a flat top with a thin lighter line. Both gauges share one grid,
 * so tops, bottoms and values line up.
 */
.hud .gauges { display: grid; grid-template-columns: auto auto; grid-template-rows: auto auto auto auto; grid-auto-flow: column; column-gap: calc(var(--u) * 1); row-gap: calc(var(--u) * 0.35); justify-items: center; padding: calc(var(--u) * 0.55) calc(var(--u) * 0.8) calc(var(--u) * 0.5) calc(var(--u) * 0.6); }
.hud .gauge { display: contents; }
.hud .gauge .gv { font-weight: 700; font-size: 0.9em; display: block; width: calc(var(--u) * 6.4); text-align: center; white-space: nowrap; height: 1.25em; contain: size layout style; }
.hud .gauge .scale { position: relative; display: flex; gap: calc(var(--u) * 0.45); align-items: stretch; margin-top: calc(var(--u) * 0.45); }
.hud .gauge .nums { position: relative; width: calc(var(--u) * 2.8); height: calc(var(--u) * 9.5); font-size: 0.78em; font-weight: 600; color: var(--label); }
.hud .gauge .nums span { position: absolute; right: 0; transform: translateY(50%); line-height: 1; }
.hud .gauge .tube { position: relative; width: calc(var(--u) * 2.3); height: calc(var(--u) * 9.5); border-radius: calc(var(--u) * 0.3); background: rgba(6, 9, 14, 0.94); border: 1px solid var(--line); overflow: hidden; box-shadow: inset 0 calc(var(--u) * 0.25) calc(var(--u) * 0.6) rgba(0, 0, 0, 0.6); }
.hud .gauge .track { position: absolute; inset: 0; opacity: 0.2; }
.hud .gauge .win { position: absolute; inset: 0; overflow: hidden; will-change: transform; transform: translateY(100%); }
.hud .gauge .win > i { position: absolute; inset: 0; will-change: transform; transform: translateY(-100%); }
.hud .gauge .win::after { content: ''; position: absolute; left: 0; right: 0; top: 0; height: max(1px, calc(var(--u) * 0.15)); background: rgba(255, 255, 255, 0.4); }
.hud .gauge.thr .track, .hud .gauge.thr .win > i { background: linear-gradient(to top, #1f9fe6, #6fdcff); }
.hud .gauge.g .track, .hud .gauge.g .win > i { background: linear-gradient(to top, #3cc97f 0%, #66e3a0 50%, #ffbb4d 50%, #ffc766 83.333%, #ff5a5a 83.333%, #ff7a7a 100%); }
.hud .gauge .ticks { position: absolute; inset: 0; background: repeating-linear-gradient(to top, transparent 0, transparent calc(100% / var(--n) - 1px), rgba(255,255,255,0.24) calc(100% / var(--n) - 1px), rgba(255,255,255,0.24) calc(100% / var(--n))); }
.hud .gauge .limit { position: absolute; left: -1px; right: -1px; height: 2px; background: #ff5a5a; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6); }
.hud .gauge .gl { font-size: 0.78em; letter-spacing: 0.08em; color: var(--label); font-weight: 600; white-space: nowrap; }
.hud .gauge .dose { width: calc(var(--u) * 5.2); height: calc(var(--u) * 0.6); }
.hud .gauge .dose .bar { height: calc(var(--u) * 0.45); }

.hud .node { position: relative; width: calc(var(--u) * 22); border-color: rgba(79, 141, 255, 0.6); }
.hud .node .ptitle { color: #9fc0ff; }
.hud .node.imminent { border-color: var(--caution); }
/* The pulse animates the opacity of a glow layer, which runs on the compositor (no paint per frame). */
.hud .node.imminent::after { content: ''; position: absolute; inset: -1px; border-radius: inherit; box-shadow: 0 0 calc(var(--u) * 1.6) rgba(255, 187, 77, 0.55); opacity: 0; animation: hud-pulse 1s ease-in-out infinite; pointer-events: none; }
@keyframes hud-pulse { 50% { opacity: 1; } }

/* ---------------------------------------------------------------- left panels */
.hud .orbit .apsis { display: grid; grid-template-columns: auto 1fr auto; gap: calc(var(--u) * 0.8); align-items: baseline; height: 1.34em; contain: size layout style; }
.hud .orbit .apsis .sub { text-align: right; min-width: 4.2em; font-size: 0.8em; }
.hud .ptitle .pright { display: flex; align-items: baseline; gap: 0.6em; }
.hud .ptitle .tag { font-weight: 700; letter-spacing: 0.08em; }
/* Atmosphere: three cells on one strip (in its own panel, under the orbit rows in an ascent, or in the entry panel). */
.hud .atmrows { display: grid; grid-template-columns: 1.25fr 1fr 1fr; column-gap: calc(var(--u) * 0.8); }
.hud .atmrows .cell { display: flex; flex-direction: column; min-width: 0; height: 2.55em; contain: size layout style; }
.hud .atmrows .cell .val { text-align: left; font-size: 0.96em; }
.hud .atmrows .cell + .cell { border-left: 1px solid rgba(170, 198, 235, 0.14); padding-left: calc(var(--u) * 0.8); }
.hud .atmrows.sepd { border-top: 1px solid var(--line); margin-top: calc(var(--u) * 0.35); padding-top: calc(var(--u) * 0.3); }
.hud .lt .tname { font-size: 1.05em; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 0.1em; }
.hud .lt .tname .pname { font-size: 1em; }
.hud .lt .ltline { font-size: 0.86em; font-weight: 600; color: var(--label); height: 1.3em; contain: size layout style; }
.hud .lt .rows .val { font-size: 0.92em; }
.hud .lt .rows .lbl { letter-spacing: 0.03em; }
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
.hud .pad .targets { display: flex; flex-wrap: wrap; gap: calc(var(--u) * 0.4); }
.hud .pad .targets button { font-size: 1.15em; letter-spacing: 0.03em; text-transform: none; padding: 0 calc(var(--u) * 0.7); color: var(--text); }
.hud .pad .targets button.on { background: rgba(255, 91, 214, 0.24); border-color: rgba(255, 91, 214, 0.8); }

/* ---------------------------------------------------------------- centre */
.hud .failed { position: absolute; left: 50%; top: 38%; transform: translate(-50%, -50%); text-align: center; background: rgba(40, 6, 8, 0.96); border: 1px solid rgba(255, 98, 98, 0.75); border-radius: calc(var(--u) * 1.2); padding: calc(var(--u) * 2) calc(var(--u) * 5); box-shadow: var(--edge), 0 0 calc(var(--u) * 6) rgba(255, 60, 60, 0.25); }
.hud .failed h2 { margin: 0; font-size: 2.4em; letter-spacing: 0.18em; color: var(--warning); font-weight: 700; }
.hud .failed p { margin: calc(var(--u) * 0.8) 0 0; font-size: 1.05em; color: #ffd5d5; }

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
.hud .help .item .kbd.locked { border-color: rgba(255, 187, 77, 0.6); color: #ffe2b0; }
`;
