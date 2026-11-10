/**
 * HUD stylesheet. Every size derives from --u = min(1vh, 0.5625vw) (one hundredth of the height of a 16:9
 * frame), so the layout is identical from 1280 x 720 to 3840 x 2160 and never overflows narrower windows.
 * Panels are dark translucent glass with a hairline border; text carries a soft shadow so it stays legible
 * over a bright Earth as well as over black space. Numerals are tabular.
 */
export const HUD_STYLE_ID = 'fable-hud-style';

export const HUD_CSS = /* css */ `
.hud {
  --u: min(1vh, 0.5625vw);
  --bg: rgba(8, 12, 18, 0.66);
  --bg-strong: rgba(8, 12, 18, 0.84);
  --line: rgba(160, 190, 230, 0.17);
  --text: #eef4fb;
  --label: #93a2b8;
  --dim: #6c7a8f;
  --accent: #55d4ff;
  --good: #5fe39a;
  --caution: #ffbb4d;
  --warning: #ff6262;
  --gap: calc(var(--u) * 1.8);
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  font-family: Bahnschrift, 'DIN Alternate', 'Segoe UI', system-ui, sans-serif;
  font-size: calc(var(--u) * 1.95);
  line-height: 1.25;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  text-shadow: 0 0.06em 0.16em rgba(0, 0, 0, 0.6);
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

.hud .panel {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: calc(var(--u) * 0.9);
  padding: calc(var(--u) * 0.9) calc(var(--u) * 1.2);
  box-shadow: 0 calc(var(--u) * 0.3) calc(var(--u) * 1.6) rgba(0, 0, 0, 0.28);
  contain: layout style;
}
.hud .ptitle {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: calc(var(--u) * 1);
  font-size: 0.74em;
  font-weight: 600;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  color: var(--label);
  margin-bottom: calc(var(--u) * 0.45);
}
.hud .ptitle .pname { color: var(--text); letter-spacing: 0.02em; text-transform: none; font-size: 1.22em; font-weight: 600; }
.hud .row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: calc(var(--u) * 1.2);
  min-height: 1.4em;
}
.hud .lbl { font-size: 0.76em; font-weight: 500; letter-spacing: 0.07em; text-transform: uppercase; color: var(--label); white-space: nowrap; }
.hud .val { font-weight: 600; white-space: nowrap; text-align: right; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.hud .val.big { font-size: 1.75em; font-weight: 600; letter-spacing: 0.01em; }
.hud .sub { font-size: 0.8em; color: var(--label); white-space: nowrap; }
.hud .t-accent { color: var(--accent); }
.hud .t-good { color: var(--good); }
.hud .t-caution { color: var(--caution); }
.hud .t-warning { color: var(--warning); }
.hud .t-dim { color: var(--dim); }

.hud button {
  pointer-events: auto;
  font: inherit;
  color: inherit;
  text-shadow: inherit;
  background: rgba(255, 255, 255, 0.05);
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
.hud .clickable { pointer-events: auto; cursor: pointer; }
.hud .kbd {
  display: inline-block;
  min-width: 1.7em;
  padding: 0.05em 0.4em;
  border: 1px solid rgba(190, 210, 240, 0.35);
  border-bottom-width: 2px;
  border-radius: 0.3em;
  background: rgba(255, 255, 255, 0.06);
  font-size: 0.78em;
  font-weight: 600;
  text-align: center;
  color: var(--text);
  white-space: nowrap;
}

/* Bars: a track and a fill scaled with transform (no layout per frame). */
.hud .bar { position: relative; height: calc(var(--u) * 0.7); border-radius: calc(var(--u) * 0.35); background: rgba(150, 175, 210, 0.16); overflow: hidden; }
.hud .bar > i { position: absolute; inset: 0; transform-origin: 0 50%; background: var(--good); border-radius: inherit; }
.hud .bar.caution > i { background: var(--caution); }
.hud .bar.warning > i { background: var(--warning); }
.hud .bar.accent > i { background: var(--accent); }

/* ---------------------------------------------------------------- corners */
.hud .tc { position: absolute; left: 50%; top: var(--gap); transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: calc(var(--u) * 1); }
.hud .tr { position: absolute; right: var(--gap); top: var(--gap); display: flex; gap: calc(var(--u) * 0.8); align-items: center; }
.hud .lcol { position: absolute; left: var(--gap); top: var(--gap); width: calc(var(--u) * 32.5); display: flex; flex-direction: column; gap: calc(var(--u) * 0.9); max-height: calc(100% - var(--gap) * 2); }
.hud .rcol { position: absolute; right: var(--gap); top: calc(var(--gap) + var(--u) * 6); width: calc(var(--u) * 33); display: flex; flex-direction: column; gap: calc(var(--u) * 1); align-items: stretch; max-height: calc(100% - var(--u) * 9); }

/* ---------------------------------------------------------------- clock + warp */
.hud .clock .met { font-size: 1.55em; font-weight: 600; letter-spacing: 0.02em; }
.hud .clock .ut { font-size: 0.82em; color: var(--label); margin-top: calc(var(--u) * 0.1); }
.hud .warp { display: flex; align-items: center; gap: calc(var(--u) * 0.6); margin-top: calc(var(--u) * 0.7); }
.hud .warp button { padding: 0 calc(var(--u) * 0.55); line-height: 1.3; font-weight: 700; }
.hud .chev { display: flex; gap: calc(var(--u) * 0.18); flex: 1; }
.hud .chev i { flex: 1; height: calc(var(--u) * 1.1); clip-path: polygon(0 0, 70% 0, 100% 50%, 70% 100%, 0 100%, 30% 50%); background: rgba(150, 175, 210, 0.22); }
.hud .chev i.on { background: var(--good); }
.hud .chev i.on.phys { background: var(--caution); }
.hud .chev i.cap { background: rgba(150, 175, 210, 0.07); }
.hud .warp .factor { min-width: 4.4em; text-align: right; font-weight: 600; }
.hud .warp-limit { font-size: 0.76em; color: var(--caution); margin-top: calc(var(--u) * 0.35); white-space: normal; }

/* ---------------------------------------------------------------- altitude */
.hud .alt { min-width: calc(var(--u) * 26); text-align: center; padding: calc(var(--u) * 0.6) calc(var(--u) * 1.6); pointer-events: auto; cursor: pointer; }
.hud .alt .val.big { display: block; text-align: center; }
.hud .alt .vs { font-size: 0.86em; color: var(--label); }

/* ---------------------------------------------------------------- toasts */
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
  animation: hud-toast-in 160ms ease-out;
}
.hud .toast.info { border-color: rgba(85, 212, 255, 0.4); border-left-color: var(--accent); }
.hud .toast .count { color: var(--caution); margin-left: 0.5em; font-weight: 700; }
.hud .toast.fade { opacity: 0; transition: opacity 400ms; }
@keyframes hud-toast-in { from { opacity: 0; transform: translateY(-30%); } to { opacity: 1; transform: none; } }

/* ---------------------------------------------------------------- top right */
.hud .pill { display: flex; align-items: center; gap: 0.5em; border-radius: 999px; padding: calc(var(--u) * 0.35) calc(var(--u) * 1.1); font-size: 0.84em; font-weight: 500; }
.hud .pill svg { width: 1.2em; height: 1.2em; flex: none; }
.hud .kbcap { background: rgba(60, 40, 8, 0.72); border-color: rgba(255, 187, 77, 0.55); color: #ffe2b0; }
.hud .kbcap b { color: var(--caution); font-weight: 700; }
.hud .kbok { background: var(--bg); color: var(--good); border: 1px solid var(--line); }
.hud .helpbtn { font-weight: 700; min-width: 2.2em; background: var(--bg-strong); }
.hud .warp button { background: var(--bg-strong); }

/* ---------------------------------------------------------------- stage stack */
.hud .stages { display: flex; flex-direction: column; gap: calc(var(--u) * 0.55); }
.hud .stages .more { font-size: 0.76em; color: var(--label); text-align: right; letter-spacing: 0.06em; text-transform: uppercase; padding-right: calc(var(--u) * 0.6); }
.hud .tile {
  display: flex;
  gap: calc(var(--u) * 0.9);
  align-items: center;
  padding: calc(var(--u) * 0.55) calc(var(--u) * 0.9);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: calc(var(--u) * 0.8);
}
.hud .tile .ico { flex: none; width: calc(var(--u) * 3.6); height: calc(var(--u) * 3.6); border-radius: calc(var(--u) * 0.6); display: flex; align-items: center; justify-content: center; background: rgba(255, 255, 255, 0.05); color: #c9d6e6; position: relative; }
.hud .tile .ico svg { width: 72%; height: 72%; }
.hud .tile .ico .num { position: absolute; right: -0.35em; bottom: -0.35em; font-size: 0.68em; font-weight: 700; background: #1b2633; border: 1px solid var(--line); border-radius: 0.5em; padding: 0 0.35em; color: var(--text); }
.hud .tile .main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: calc(var(--u) * 0.25); }
.hud .tile .l1, .hud .tile .l2 { display: flex; align-items: center; gap: calc(var(--u) * 0.7); min-width: 0; }
.hud .tile .name { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hud .tile .acts { display: flex; gap: 0.2em; color: var(--label); flex: none; }
.hud .tile .acts svg { width: 1.05em; height: 1.05em; }
.hud .tile .dv { flex: none; font-weight: 600; font-size: 0.92em; text-align: right; white-space: nowrap; }
.hud .tile .meta { flex: 1; min-width: 0; font-size: 0.76em; color: var(--label); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hud .tile .bar { flex: none; height: calc(var(--u) * 0.55); width: calc(var(--u) * 7.5); }
.hud .tile.next { border-color: rgba(85, 212, 255, 0.75); background: rgba(10, 30, 44, 0.78); box-shadow: 0 0 0 1px rgba(85, 212, 255, 0.25), 0 0 calc(var(--u) * 1.4) rgba(85, 212, 255, 0.18); pointer-events: auto; cursor: pointer; }
.hud .tile.next .ico { background: rgba(85, 212, 255, 0.18); color: var(--accent); }
.hud .tile.next:hover { background: rgba(14, 44, 64, 0.85); }
.hud .tile.next .hint { color: var(--accent); }
.hud .tile.locked { border-color: rgba(255, 187, 77, 0.6); cursor: default; }
.hud .tile.locked .hint { color: var(--caution); }
.hud .tile .hint { font-size: 0.7em; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
.hud .tile .hint .kbd { font-size: 0.95em; }

/* ---------------------------------------------------------------- resources */
.hud .res .grp + .grp { margin-top: calc(var(--u) * 0.6); }
.hud .res .gname { font-size: 0.72em; letter-spacing: 0.1em; text-transform: uppercase; color: var(--accent); font-weight: 600; margin-bottom: calc(var(--u) * 0.2); }
.hud .res .rrow { display: grid; grid-template-columns: 1fr calc(var(--u) * 11) 3.2em; gap: calc(var(--u) * 0.8); align-items: center; font-size: 0.86em; }
.hud .res .rrow .rn { color: var(--label); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hud .res .rrow .rp { text-align: right; font-weight: 600; }

/* ---------------------------------------------------------------- bottom cluster */
.hud .bottom { position: absolute; left: 50%; bottom: calc(var(--u) * 1.4); transform: translateX(-50%); display: flex; align-items: flex-end; gap: calc(var(--u) * 1.2); }
.hud .sas { width: calc(var(--u) * 17.5); display: flex; flex-direction: column; gap: calc(var(--u) * 0.6); }
.hud .toggles { display: grid; grid-template-columns: 1fr 1fr; gap: calc(var(--u) * 0.45); }
.hud .toggles button { font-size: 0.74em; font-weight: 700; letter-spacing: 0.08em; padding: calc(var(--u) * 0.3) 0; color: var(--label); }
.hud .toggles button.on { color: #04121a; background: var(--accent); border-color: var(--accent); text-shadow: none; }
.hud .toggles button.on.sasbtn { background: var(--good); border-color: var(--good); }
.hud .toggles button.abort { color: var(--warning); border-color: rgba(255, 98, 98, 0.4); }
.hud .modes { display: grid; grid-template-columns: repeat(4, 1fr); gap: calc(var(--u) * 0.45); }
.hud .modes button { aspect-ratio: 1; padding: 12%; display: flex; align-items: center; justify-content: center; position: relative; }
.hud .modes button svg { width: 100%; height: 100%; filter: drop-shadow(0 0 0.08em rgba(0,0,0,0.8)); }
.hud .modes button.on { border-color: rgba(95, 227, 154, 0.95); background: rgba(95, 227, 154, 0.2); box-shadow: inset 0 0 0 1px rgba(95, 227, 154, 0.6); }
.hud .modes button .key { position: absolute; left: 0.25em; top: 0.1em; font-size: 0.56em; font-weight: 700; color: var(--label); }
.hud .modecap { font-size: 0.72em; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; color: var(--label); text-align: center; white-space: nowrap; }
.hud .modecap b { color: var(--good); font-weight: 700; }

.hud .nbwrap { display: flex; flex-direction: column; align-items: center; gap: calc(var(--u) * 0.5); }
.hud .speed { text-align: center; padding: calc(var(--u) * 0.45) calc(var(--u) * 1.5); pointer-events: auto; cursor: pointer; min-width: calc(var(--u) * 22); }
.hud .speed .val.big { font-size: 1.55em; display: block; text-align: center; }
.hud .speed .mode { color: var(--accent); }
.hud .ball { position: relative; width: calc(var(--u) * 29); height: calc(var(--u) * 29); }
.hud .ball canvas { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 50%; }
.hud .ball .bezel { position: absolute; inset: calc(var(--u) * 0.2); border-radius: 50%; border: calc(var(--u) * 0.85) solid rgba(10, 15, 22, 0.78); box-shadow: inset 0 0 0 1px rgba(170, 200, 240, 0.28), 0 0 0 1px rgba(170, 200, 240, 0.22), 0 calc(var(--u) * 0.5) calc(var(--u) * 2.4) rgba(0, 0, 0, 0.45); pointer-events: none; }
.hud .ball .hdg { position: absolute; left: 50%; top: calc(var(--u) * -1.7); transform: translateX(-50%); background: var(--bg-strong); border: 1px solid var(--line); border-radius: calc(var(--u) * 0.5); padding: 0 calc(var(--u) * 0.7); font-weight: 700; font-size: 0.92em; }
.hud .ball .pr { position: absolute; bottom: calc(var(--u) * -0.4); font-size: 0.74em; font-weight: 600; background: var(--bg-strong); border: 1px solid var(--line); border-radius: calc(var(--u) * 0.5); padding: 0 calc(var(--u) * 0.6); white-space: nowrap; }
.hud .ball .pr .lbl { font-size: 0.9em; margin-right: 0.35em; }
.hud .ball .pitch { left: calc(var(--u) * -1.2); }
.hud .ball .roll { right: calc(var(--u) * -1.2); }

.hud .gauges { display: flex; gap: calc(var(--u) * 0.6); align-items: flex-end; padding: calc(var(--u) * 0.8) calc(var(--u) * 0.6); }
.hud .gauge { display: flex; flex-direction: column; align-items: center; gap: calc(var(--u) * 0.45); width: calc(var(--u) * 7.6); }
.hud .gauge .tube { position: relative; width: calc(var(--u) * 2.6); height: calc(var(--u) * 19); border-radius: calc(var(--u) * 1.3); background: var(--bg); border: 1px solid var(--line); overflow: hidden; }
.hud .gauge .tube > i { position: absolute; left: 0; right: 0; bottom: 0; height: 100%; transform-origin: 50% 100%; background: linear-gradient(to top, #2bb8ff, #7fe3ff); }
.hud .gauge.g .tube > i { background: linear-gradient(to top, #5fe39a, #ffbb4d 55%, #ff6262); }
.hud .gauge .tube .ticks { position: absolute; inset: 0; background: repeating-linear-gradient(to top, transparent 0, transparent calc(10% - 1px), rgba(255,255,255,0.22) calc(10% - 1px), rgba(255,255,255,0.22) 10%); }
.hud .gauge .gv { font-weight: 700; font-size: 0.9em; }
.hud .gauge .gl { font-size: 0.62em; letter-spacing: 0.08em; color: var(--label); font-weight: 600; white-space: nowrap; }
.hud .gauge .dose { width: 100%; }
.hud .gauge .dose .bar { height: calc(var(--u) * 0.45); }

.hud .node { width: calc(var(--u) * 25); border-color: rgba(79, 141, 255, 0.55); }
.hud .node .ptitle { color: #8fb4ff; }
.hud .node.imminent { border-color: var(--caution); animation: hud-pulse 1s ease-in-out infinite; }
@keyframes hud-pulse { 50% { box-shadow: 0 0 calc(var(--u) * 1.6) rgba(255, 187, 77, 0.45); } }

/* ---------------------------------------------------------------- left panels */
.hud .orbit .apsis { display: grid; grid-template-columns: auto 1fr auto; gap: calc(var(--u) * 1); align-items: baseline; min-height: 1.4em; }
.hud .orbit .apsis .sub { text-align: right; min-width: 4.6em; font-size: 0.74em; }
.hud .lt .inside { color: var(--good); font-weight: 700; font-size: 0.72em; letter-spacing: 0.08em; }
.hud .lt .pred { margin-top: calc(var(--u) * 0.3); padding-top: calc(var(--u) * 0.35); border-top: 1px solid var(--line); }
.hud .entry .lift { font-weight: 700; color: #7dffa8; letter-spacing: 0.08em; }
.hud .entry .light { display: inline-flex; align-items: center; gap: 0.4em; font-weight: 700; letter-spacing: 0.06em; }
.hud .entry .light::before { content: ''; width: 0.75em; height: 0.75em; border-radius: 50%; background: currentColor; box-shadow: 0 0 0.6em currentColor; }
.hud .entry .bar { margin: calc(var(--u) * 0.15) 0 calc(var(--u) * 0.35); }
.hud .pad .targets { display: flex; flex-wrap: wrap; gap: calc(var(--u) * 0.4); margin: calc(var(--u) * 0.2) 0 calc(var(--u) * 0.4); }
.hud .pad .targets button { font-size: 0.8em; }
.hud .pad .targets button.on { background: rgba(255, 91, 214, 0.22); border-color: rgba(255, 91, 214, 0.75); }

/* ---------------------------------------------------------------- centre */
.hud .notice { position: absolute; left: 50%; bottom: calc(var(--u) * 37); transform: translateX(-50%); }
.hud .notice .pill { background: var(--bg-strong); border: 1px solid rgba(85, 212, 255, 0.45); color: var(--accent); }
.hud .notice .spin { width: 0.9em; height: 0.9em; border-radius: 50%; border: 0.16em solid rgba(85, 212, 255, 0.3); border-top-color: var(--accent); animation: hud-spin 0.9s linear infinite; }
@keyframes hud-spin { to { transform: rotate(360deg); } }
.hud .failed { position: absolute; left: 50%; top: 38%; transform: translate(-50%, -50%); text-align: center; background: rgba(40, 6, 8, 0.86); border: 1px solid rgba(255, 98, 98, 0.75); border-radius: calc(var(--u) * 1.2); padding: calc(var(--u) * 2) calc(var(--u) * 5); box-shadow: 0 0 calc(var(--u) * 6) rgba(255, 60, 60, 0.25); }
.hud .failed h2 { margin: 0; font-size: 2.4em; letter-spacing: 0.18em; color: var(--warning); font-weight: 700; }
.hud .failed p { margin: calc(var(--u) * 0.8) 0 0; font-size: 1.05em; color: #ffd5d5; }

/* ---------------------------------------------------------------- key help */
.hud .help { position: absolute; inset: 0; background: rgba(2, 4, 8, 0.62); display: flex; align-items: center; justify-content: center; pointer-events: auto; }
.hud .help .sheet { background: rgba(10, 15, 22, 0.94); border: 1px solid var(--line); border-radius: calc(var(--u) * 1.4); padding: calc(var(--u) * 2.4) calc(var(--u) * 3); width: min(calc(var(--u) * 150), 94%); max-height: 92%; overflow: hidden; box-shadow: 0 calc(var(--u) * 2) calc(var(--u) * 8) rgba(0, 0, 0, 0.6); }
.hud .help .head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: calc(var(--u) * 1.4); }
.hud .help h2 { margin: 0; font-size: 1.45em; letter-spacing: 0.04em; font-weight: 600; }
.hud .help .note { color: var(--label); font-size: 0.82em; margin-top: calc(var(--u) * 0.3); }
.hud .help .cols { columns: 3; column-gap: calc(var(--u) * 3.2); }
.hud .help .group { break-inside: avoid; margin-bottom: calc(var(--u) * 1.4); }
.hud .help .group h3 { margin: 0 0 calc(var(--u) * 0.5); font-size: 0.74em; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); font-weight: 600; }
.hud .help .item { display: flex; justify-content: space-between; align-items: center; gap: calc(var(--u) * 1); padding: calc(var(--u) * 0.18) 0; font-size: 0.86em; border-bottom: 1px solid rgba(160, 190, 230, 0.07); }
.hud .help .item .keys { display: flex; gap: 0.3em; flex-wrap: wrap; justify-content: flex-end; }
.hud .help .item .kbd.locked { border-color: rgba(255, 187, 77, 0.6); color: #ffe2b0; }
`;
