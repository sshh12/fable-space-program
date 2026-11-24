/**
 * The menu's DOM kit (frontend-ux 4.3-4.11, in the HUD's visual language: src/core/ui/theme.ts): tokens and
 * styles, the safe frame, panels, cards, list rows, the tab bar, key caps and the prompt bar; spatial focus
 * navigation shared by keyboard and mouse; and the panels' rectangles for the render core's scrim step.
 *
 * Rules kept here: the unit `u` is the HUD's (`min(1vh, 0.5625vw)`) times the UI scale, and every size has a
 * pixel floor, so 1280 x 720 and 3840 x 2160 read alike; only `transform` and `opacity` animate; no CSS
 * backdrop-filter, filter blur or blend mode over the canvas (the blur under a panel is the scrim step, drawn by
 * the core inside the rectangles `scrimRectsOf` measures); reduced motion turns slides into fades.
 */
import { UI_COLORS } from '@/core/ui/theme';

/** Families of the shipped OFL type (public/assets/ui/fonts, credits.json): display, labels and body. */
export const SHELL_FONTS = {
  display: "'Barlow Condensed', Bahnschrift, 'Segoe UI', system-ui, sans-serif",
  label: "'Barlow Semi Condensed', Bahnschrift, 'Segoe UI', system-ui, sans-serif",
  body: "Barlow, Bahnschrift, 'Segoe UI', system-ui, sans-serif",
} as const;

/** The font files and their faces. */
export const SHELL_FONT_FILES: readonly { family: string; weight: number; file: string }[] = [
  { family: 'Barlow', weight: 400, file: 'barlow-400.woff2' },
  { family: 'Barlow', weight: 500, file: 'barlow-500.woff2' },
  { family: 'Barlow Condensed', weight: 500, file: 'barlowcondensed-500.woff2' },
  { family: 'Barlow Condensed', weight: 600, file: 'barlowcondensed-600.woff2' },
  { family: 'Barlow Condensed', weight: 700, file: 'barlowcondensed-700.woff2' },
  { family: 'Barlow Semi Condensed', weight: 500, file: 'barlowsemicondensed-500.woff2' },
  { family: 'Barlow Semi Condensed', weight: 600, file: 'barlowsemicondensed-600.woff2' },
];

/** Register the shipped faces with the document; resolves when all are loaded (a failure is reported, the fallback stack reads on). */
export async function loadShellFonts(baseUrl: string, onError: (message: string) => void): Promise<void> {
  await Promise.all(
    SHELL_FONT_FILES.map(async (f) => {
      const face = new FontFace(f.family, `url(${baseUrl}${f.file}) format('woff2')`, { weight: String(f.weight), style: 'normal', display: 'block' });
      try {
        document.fonts.add(await face.load());
      } catch (err) {
        onError(`font ${f.file} did not load: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}

const STYLE_ID = 'shell-styles';

/** The menu's styles, installed once per document. */
export function installShellStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = SHELL_CSS;
  doc.head.appendChild(style);
}

const C = UI_COLORS;

const SHELL_CSS = `
.sh-root {
  --u: calc(min(1vh, 0.5625vw) * var(--sh-scale, 1));
  --ink: ${C.text}; --ink-2: ${C.label}; --ink-3: ${C.dim};
  --accent: ${C.accent}; --ok: ${C.good}; --warn: ${C.caution}; --alert: ${C.warning};
  --line: ${C.line};
  --fill: rgba(9, 13, 19, 0.66); --fill-strong: rgba(9, 13, 19, 0.8); --fill-focus: rgba(30, 52, 70, 0.72);
  --t-fast: 120ms; --t-base: 220ms; --t-exit: 160ms; --t-screen: 420ms;
  --ease: cubic-bezier(0.2, 0, 0, 1); --ease-exit: cubic-bezier(0.4, 0, 1, 1);
  position: fixed; inset: 0; pointer-events: none; color: var(--ink);
  font-family: ${SHELL_FONTS.body}; font-size: max(14px, calc(1.5 * var(--u))); line-height: 1.35;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; user-select: none;
  z-index: 20;
}
.sh-root[data-motion="reduced"] { --t-fast: 0ms; --t-base: 160ms; --t-exit: 120ms; --t-screen: 200ms; }
.sh-root[hidden] { display: none; }
.sh-root * { box-sizing: border-box; }
/* A gradient vignette behind the left columns and the bottom bands: free text (titles, the status line) stays
   legible over a bright scene. A plain gradient over the canvas: no blur, no blend (frontend-ux fact 7). */
.sh-vignette { position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(90deg, rgba(4, 7, 11, 0.7) 0%, rgba(4, 7, 11, 0.5) 30%, rgba(4, 7, 11, 0.14) 48%, rgba(4, 7, 11, 0) 60%),
              linear-gradient(180deg, rgba(4, 7, 11, 0.62) 0%, rgba(4, 7, 11, 0.3) 9%, rgba(4, 7, 11, 0) 18%),
              linear-gradient(0deg, rgba(4, 7, 11, 0.6) 0%, rgba(4, 7, 11, 0) 16%); }
.sh-title, .sh-subtitle, .sh-status, .sh-wordmark, .sh-begin, .sh-tab, .sh-top-right { text-shadow: 0 0 0.5em rgba(0, 0, 0, 0.55), 0 1px 2px rgba(0, 0, 0, 0.6); }
.sh-safe {
  position: absolute; left: 50%; top: 50%;
  width: min(100vw, calc(100vh * 16 / 9)); height: min(100vh, calc(100vw * 9 / 16));
  transform: translate(-50%, -50%);
  padding: calc(4.5 * var(--u)) calc(5 * var(--u));
  display: grid; grid-template-columns: repeat(12, 1fr); column-gap: calc(1.6 * var(--u));
  grid-template-rows: auto 1fr auto auto;
}
.sh-top { grid-column: 1 / -1; grid-row: 1; display: flex; align-items: center; gap: calc(2.2 * var(--u)); min-height: calc(7 * var(--u)); }
.sh-main { grid-column: 1 / span 5; grid-row: 2; min-height: 0; display: flex; flex-direction: column; gap: calc(1.6 * var(--u)); padding-top: calc(2.4 * var(--u)); padding-bottom: calc(1.6 * var(--u)); overflow-x: hidden; overflow-y: auto; scrollbar-width: none; }
.sh-main::-webkit-scrollbar, .sh-scroll::-webkit-scrollbar { display: none; }
.sh-screen > * { display: flex; flex-direction: column; gap: calc(1.4 * var(--u)); flex-shrink: 0; }
.sh-screen > * > *, .sh-list > * { flex-shrink: 0; }
.sh-main.sh-wide { grid-column: 1 / span 7; }
.sh-aside { grid-column: 8 / span 5; grid-row: 2 / span 2; align-self: end; display: flex; flex-direction: column; gap: calc(1.2 * var(--u)); min-height: 0; max-height: 100%; padding-bottom: calc(1.6 * var(--u)); }
.sh-main.sh-wide ~ .sh-aside { grid-column: 9 / span 4; }
.sh-scroll, .sh-list.sh-scroll { overflow-y: auto; scrollbar-width: none; max-height: calc(44 * var(--u)); overscroll-behavior: contain; }
.sh-card.sh-commit { min-height: calc(13 * var(--u)); border-color: rgba(85, 212, 255, 0.55); background: var(--fill-strong); }
.sh-card.sh-commit .sh-card-text { color: var(--ink); }
.sh-card.sh-commit .sh-card-title { font-size: max(26px, calc(3.6 * var(--u))); }
.sh-detail-title { font-family: ${SHELL_FONTS.display}; font-weight: 700; font-size: max(24px, calc(3.4 * var(--u))); text-transform: uppercase; line-height: 1; margin: calc(0.4 * var(--u)) 0 calc(0.8 * var(--u)); }
.sh-panel .sh-body + .sh-body { margin-top: calc(0.5 * var(--u)); }
.sh-panel > * + .sh-label, .sh-panel > * + .sh-readouts, .sh-panel > * + .sh-ladder { margin-top: calc(1.3 * var(--u)); }
.sh-panel > .sh-label + * { margin-top: calc(0.45 * var(--u)); }
.sh-row.sh-static { cursor: default; }
.sh-code { font-family: ${SHELL_FONTS.display}; font-weight: 700; font-feature-settings: 'tnum' 1; font-size: max(26px, calc(3.6 * var(--u))); letter-spacing: 0.08em; margin: calc(0.6 * var(--u)) 0 calc(1.0 * var(--u)); user-select: text; }
.sh-callsign-row { display: flex; align-items: center; gap: calc(1.0 * var(--u)); }
.sh-callsign-row .sh-field { flex: 1; }
.sh-verdict { min-height: 1.6em; margin: calc(0.8 * var(--u)) 0 calc(0.4 * var(--u)); font-family: ${SHELL_FONTS.label}; font-weight: 600; letter-spacing: 0.06em; display: flex; flex-wrap: wrap; align-items: center; gap: calc(0.8 * var(--u)); }
.sh-chip { font: inherit; color: var(--ink); background: var(--fill-strong); border: 1px solid var(--line); border-radius: 2px; padding: calc(0.2 * var(--u)) calc(0.8 * var(--u)); cursor: pointer; pointer-events: auto; }
.sh-chip.is-focus { border-color: var(--accent); color: var(--accent); }
.sh-status { grid-column: 1 / span 7; grid-row: 3; align-self: end; font-family: ${SHELL_FONTS.label}; font-weight: 500; font-size: max(12px, calc(1.25 * var(--u))); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink); padding-bottom: calc(0.8 * var(--u)); contain: layout; }
.sh-prompts { grid-column: 6 / -1; grid-row: 4; justify-self: end; display: flex; gap: calc(2 * var(--u)); align-items: center; min-height: calc(4.5 * var(--u)); }
.sh-pointer { pointer-events: auto; }

.sh-panel { position: relative; background: var(--fill); border: 1px solid var(--line); border-radius: 2px; padding: calc(1.8 * var(--u)) calc(2.2 * var(--u)); pointer-events: auto; }
.sh-panel.sh-strong { background: var(--fill-strong); }
.sh-panel > .sh-label:first-child { margin-bottom: calc(0.8 * var(--u)); }

.sh-wordmark { font-family: ${SHELL_FONTS.display}; font-weight: 700; text-transform: uppercase; line-height: 0.86; letter-spacing: -0.01em; font-size: max(56px, calc(9 * var(--u))); }
.sh-wordmark span { display: block; }
.sh-wordmark .sh-wm-2 { font-weight: 500; font-size: 0.42em; letter-spacing: 0.32em; color: var(--ink-2); margin-top: calc(1.2 * var(--u)); }
.sh-title { font-family: ${SHELL_FONTS.display}; font-weight: 700; text-transform: uppercase; font-size: max(34px, calc(5.2 * var(--u))); line-height: 0.95; letter-spacing: 0.005em; margin: 0; }
.sh-title::after { content: ''; display: block; width: calc(6 * var(--u)); height: max(2px, calc(0.25 * var(--u))); background: var(--accent); margin-top: calc(1.2 * var(--u)); }
.sh-subtitle { font-family: ${SHELL_FONTS.label}; font-weight: 500; font-size: max(14px, calc(1.6 * var(--u))); color: var(--ink); letter-spacing: 0.02em; margin: 0; }
.sh-label { font-family: ${SHELL_FONTS.label}; font-weight: 600; font-size: max(12px, calc(1.25 * var(--u))); letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-2); }
.sh-body { font-size: max(14px, calc(1.5 * var(--u))); color: var(--ink); margin: 0; }
.sh-body.sh-dim { color: var(--ink-2); }
.sh-num { font-family: ${SHELL_FONTS.display}; font-weight: 600; font-feature-settings: 'tnum' 1; }
.sh-warn { color: var(--warn); } .sh-alert { color: var(--alert); } .sh-ok { color: var(--ok); } .sh-accent { color: var(--accent); }

.sh-tabs { display: flex; align-items: center; gap: calc(2.6 * var(--u)); background: var(--fill); border: 1px solid var(--line); border-radius: 2px; padding: calc(0.3 * var(--u)) calc(1.4 * var(--u)); pointer-events: auto; }
.sh-tab { font-family: ${SHELL_FONTS.display}; font-weight: 600; font-size: max(16px, calc(1.9 * var(--u))); letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-2); background: none; border: 0; padding: calc(0.6 * var(--u)) 0; position: relative; cursor: pointer; pointer-events: auto; }
.sh-tab[aria-selected="true"] { color: var(--ink); }
.sh-tab[aria-selected="true"]::after { content: ''; position: absolute; left: 0; right: 0; bottom: calc(-0.4 * var(--u)); height: max(2px, calc(0.25 * var(--u))); background: var(--accent); }
.sh-tab.is-focus { color: var(--accent); }
.sh-top-right { margin-left: auto; display: flex; gap: calc(2.2 * var(--u)); align-items: center; font-family: ${SHELL_FONTS.label}; font-weight: 600; font-size: max(12px, calc(1.3 * var(--u))); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink); contain: layout; background: var(--fill); border: 1px solid var(--line); border-radius: 2px; padding: calc(0.5 * var(--u)) calc(1.2 * var(--u)); }
.sh-top-right:empty { display: none; }
.sh-top-right b { color: var(--ink); font-weight: 700; }
.sh-dot { display: inline-block; width: 0.55em; height: 0.55em; border-radius: 50%; background: var(--ok); margin-right: 0.45em; vertical-align: 0.05em; }
.sh-dot.sh-warn-bg { background: var(--warn); } .sh-dot.sh-alert-bg { background: var(--alert); } .sh-dot.sh-off { background: var(--ink-3); }

.sh-key { display: inline-flex; align-items: center; justify-content: center; min-width: max(20px, calc(2.2 * var(--u))); height: max(20px, calc(2.2 * var(--u))); padding: 0 0.45em; border: 1px solid rgba(238, 244, 251, 0.55); border-radius: 3px; font-family: ${SHELL_FONTS.label}; font-weight: 600; font-size: max(11px, calc(1.15 * var(--u))); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink); background: rgba(9, 13, 19, 0.5); }
.sh-prompt { display: inline-flex; align-items: center; gap: 0.6em; font-family: ${SHELL_FONTS.label}; font-weight: 600; font-size: max(12px, calc(1.3 * var(--u))); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink); background: none; border: 0; cursor: pointer; pointer-events: auto; padding: calc(0.5 * var(--u)) calc(0.9 * var(--u)); border-radius: 2px; }
.sh-prompts-plate { display: flex; gap: calc(0.6 * var(--u)); background: var(--fill); border: 1px solid var(--line); border-radius: 2px; padding: calc(0.4 * var(--u)) calc(0.6 * var(--u)); pointer-events: auto; }

.sh-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: calc(1.4 * var(--u)); }
.sh-card { text-align: left; color: var(--ink); background: var(--fill); border: 1px solid var(--line); border-radius: 2px; padding: calc(1.8 * var(--u)) calc(1.8 * var(--u)) calc(1.6 * var(--u)); min-height: calc(17 * var(--u)); display: flex; flex-direction: column; justify-content: flex-start; gap: calc(0.6 * var(--u)); cursor: pointer; pointer-events: auto; position: relative; transition: transform var(--t-fast) var(--ease), background-color var(--t-fast) var(--ease); font: inherit; }
.sh-card .sh-card-title { font-family: ${SHELL_FONTS.display}; font-weight: 600; font-size: max(20px, calc(2.6 * var(--u))); letter-spacing: 0.01em; text-transform: uppercase; line-height: 1; }
.sh-card .sh-card-text { font-size: max(13px, calc(1.35 * var(--u))); color: var(--ink-2); }
.sh-card .sh-card-kicker { font-family: ${SHELL_FONTS.label}; font-weight: 600; font-size: max(11px, calc(1.15 * var(--u))); letter-spacing: 0.16em; text-transform: uppercase; color: var(--accent); margin-bottom: auto; padding-bottom: calc(1.2 * var(--u)); }
.sh-card.is-focus, .sh-row.is-focus { background: var(--fill-focus); }
.sh-card.is-focus { transform: scale(1.03); }
.sh-card.is-focus::before, .sh-row.is-focus::before { content: ''; position: absolute; left: -1px; top: -1px; bottom: -1px; width: max(3px, calc(0.3 * var(--u))); background: var(--accent); }
.sh-card[aria-disabled="true"], .sh-row[aria-disabled="true"] { opacity: 0.45; }

.sh-list { display: flex; flex-direction: column; gap: 1px; pointer-events: auto; overflow: hidden; }
.sh-row { position: relative; display: grid; grid-template-columns: auto 1fr auto; align-items: center; column-gap: calc(1.2 * var(--u)); min-height: calc(4.4 * var(--u)); padding: calc(0.7 * var(--u)) calc(1.6 * var(--u)); background: var(--fill); border: 0; color: var(--ink); text-align: left; cursor: pointer; font: inherit; transition: background-color var(--t-fast) var(--ease); }
.sh-row + .sh-row { border-top: 1px solid rgba(170, 198, 235, 0.10); }
.sh-row-main { font-family: ${SHELL_FONTS.display}; font-weight: 600; font-size: max(16px, calc(1.9 * var(--u))); text-transform: uppercase; letter-spacing: 0.02em; line-height: 1.05; }
.sh-row-sub { display: block; font-family: ${SHELL_FONTS.body}; font-weight: 400; font-size: max(12px, calc(1.25 * var(--u))); color: var(--ink-2); text-transform: none; letter-spacing: 0; margin-top: 0.15em; }
.sh-row-right { font-family: ${SHELL_FONTS.display}; font-weight: 600; font-feature-settings: 'tnum' 1; font-size: max(14px, calc(1.6 * var(--u))); text-align: right; white-space: nowrap; }
.sh-row-right small { display: block; font-family: ${SHELL_FONTS.label}; font-weight: 500; font-size: max(11px, calc(1.1 * var(--u))); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-2); }
.sh-glyph { width: max(10px, calc(1.1 * var(--u))); height: max(10px, calc(1.1 * var(--u))); border: 2px solid var(--ink-2); border-radius: 50%; }
.sh-glyph.sh-free { border-color: var(--ok); background: var(--ok); }
.sh-glyph.sh-busy { border-color: var(--warn); }
.sh-glyph.sh-closed { border-color: var(--alert); border-radius: 1px; }
.sh-glyph.sh-chevron { border: 0; border-left: max(5px, calc(0.6 * var(--u))) solid transparent; border-right: max(5px, calc(0.6 * var(--u))) solid transparent; border-bottom: max(9px, calc(1.0 * var(--u))) solid var(--accent); border-radius: 0; width: 0; height: 0; }
.sh-group { font-family: ${SHELL_FONTS.label}; font-weight: 600; font-size: max(12px, calc(1.25 * var(--u))); letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-2); padding: calc(1.0 * var(--u)) calc(1.6 * var(--u)) calc(0.4 * var(--u)); background: var(--fill-strong); }
.sh-group b { color: var(--ink); font-weight: 600; }

.sh-readouts { display: grid; grid-template-columns: repeat(3, 1fr); gap: calc(1.2 * var(--u)) calc(1.6 * var(--u)); }
.sh-readout .sh-label { display: block; font-size: max(11px, calc(1.1 * var(--u))); }
.sh-readout .sh-num { font-size: max(18px, calc(2.2 * var(--u))); line-height: 1.1; }
.sh-readout .sh-unit { font-family: ${SHELL_FONTS.label}; font-size: max(11px, calc(1.1 * var(--u))); color: var(--ink-2); margin-left: 0.3em; }
.sh-ladder { display: flex; flex-wrap: wrap; gap: calc(0.6 * var(--u)) calc(1.4 * var(--u)); font-family: ${SHELL_FONTS.label}; font-weight: 600; font-size: max(12px, calc(1.25 * var(--u))); letter-spacing: 0.08em; text-transform: uppercase; }

.sh-queue { border-left: max(3px, calc(0.3 * var(--u))) solid var(--warn); }
.sh-queue .sh-queue-place { font-family: ${SHELL_FONTS.display}; font-weight: 700; font-size: max(28px, calc(4.2 * var(--u))); line-height: 1; font-feature-settings: 'tnum' 1; }
.sh-banner { position: absolute; right: calc(5 * var(--u)); top: calc(13 * var(--u)); width: calc(52 * var(--u)); max-width: 40vw; text-align: left; display: flex; flex-direction: column; gap: calc(1.0 * var(--u)); }
.sh-banner .sh-label { color: var(--warn); }
.sh-field { width: 100%; font-family: ${SHELL_FONTS.display}; font-weight: 600; font-size: max(18px, calc(2.2 * var(--u))); text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink); background: rgba(9, 13, 19, 0.72); border: 1px solid var(--line); border-radius: 2px; padding: calc(0.6 * var(--u)) calc(1.0 * var(--u)); outline: none; pointer-events: auto; }
.sh-field.is-focus, .sh-field:focus { border-color: var(--accent); }
.sh-ticker { font-family: ${SHELL_FONTS.label}; font-weight: 500; font-size: max(13px, calc(1.4 * var(--u))); color: var(--ink); letter-spacing: 0.04em; }
.sh-ticker::before { content: ''; display: inline-block; border-left: 0.55em solid var(--accent); border-top: 0.32em solid transparent; border-bottom: 0.32em solid transparent; margin-right: 0.7em; vertical-align: 0.05em; }
.sh-begin { grid-column: 1 / -1; grid-row: 2; align-self: end; justify-self: center; text-align: center; margin-bottom: calc(6 * var(--u)); background: var(--fill-strong); border: 1px solid var(--line); border-radius: 2px; padding: calc(1.0 * var(--u)) calc(2.6 * var(--u)); }
.sh-begin[hidden] { display: none; }
.sh-begin .sh-label { font-size: max(15px, calc(1.8 * var(--u))); letter-spacing: 0.32em; color: var(--ink); }
.sh-progress { display: grid; grid-template-columns: 1fr auto; gap: 0.2em 1.4em; font-family: ${SHELL_FONTS.label}; font-weight: 500; font-size: max(12px, calc(1.25 * var(--u))); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-2); }
.sh-progress .sh-num { color: var(--ink); text-align: right; }
.sh-bar { height: max(3px, calc(0.35 * var(--u))); background: rgba(170, 198, 235, 0.18); position: relative; overflow: hidden; }
.sh-bar > i { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; background: var(--accent); transform-origin: left center; }
.sh-rules { display: grid; grid-template-columns: 1fr 1fr; gap: calc(1.2 * var(--u)) calc(1.6 * var(--u)); overflow: hidden; }
.sh-rules h3 { font-family: ${SHELL_FONTS.display}; font-weight: 600; font-size: max(16px, calc(1.9 * var(--u))); text-transform: uppercase; letter-spacing: 0.03em; margin: 0 0 calc(0.4 * var(--u)); }
.sh-rules p { margin: 0 0 0.35em; font-size: max(12px, calc(1.25 * var(--u))); color: var(--ink); line-height: 1.32; }
.sh-credits { columns: 2; column-gap: calc(2.4 * var(--u)); }
.sh-credit { break-inside: avoid; margin-bottom: calc(1.0 * var(--u)); font-size: max(12px, calc(1.2 * var(--u))); line-height: 1.3; }
.sh-credit b { font-family: ${SHELL_FONTS.display}; font-weight: 600; font-size: 1.2em; text-transform: uppercase; letter-spacing: 0.02em; display: block; }
.sh-credit i { font-style: normal; color: var(--ink-2); display: block; }
.sh-screen { display: contents; }
.sh-enter { animation: sh-in var(--t-screen) var(--ease) both; }
.sh-root[data-motion="reduced"] .sh-enter { animation-name: sh-fade; }
@keyframes sh-in { from { opacity: 0; transform: translateX(calc(2 * var(--u))); } to { opacity: 1; transform: none; } }
@keyframes sh-fade { from { opacity: 0; } to { opacity: 1; } }
.sh-small-window { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(6, 9, 13, 0.92); color: var(--ink); font-family: ${SHELL_FONTS.label}; letter-spacing: 0.1em; text-transform: uppercase; pointer-events: auto; }
@media (max-width: 1023px), (max-height: 599px) { .sh-small-window { display: flex; } }
`;

/** Make an element: tag, class names, text or children. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...children: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const c of children) if (c !== null && c !== false) e.append(c);
  return e;
}

/** A focusable control: `data-focus` puts it in the spatial navigation; `onActivate` runs on Enter, Space or a click. */
export function focusable<T extends HTMLElement>(e: T, id: string, onActivate: () => void): T {
  e.dataset['focus'] = id;
  e.tabIndex = -1;
  e.addEventListener('click', (ev) => {
    ev.preventDefault();
    // A disabled control takes the pointer's focus but does nothing, as by key (`activate` is not called for it).
    if (e.getAttribute('aria-disabled') !== 'true') onActivate();
  });
  (e as HTMLElement & { shActivate?: () => void }).shActivate = onActivate;
  return e;
}

/** Run the activation of a focusable element (keyboard Enter / Space). */
export function activate(e: HTMLElement): void {
  (e as HTMLElement & { shActivate?: () => void }).shActivate?.();
}

export type Direction = 'up' | 'down' | 'left' | 'right';

/**
 * Spatial focus navigation (frontend-ux 4.9): the nearest focusable element in the pressed direction, inside a
 * cone of +-45 deg, by the distance between the facing edges with the cross offset weighted double. Null when
 * nothing lies that way.
 */
export function nextInDirection(from: DOMRect, candidates: readonly { id: string; rect: DOMRect }[], dir: Direction): string | null {
  const fx = from.left + from.width / 2;
  const fy = from.top + from.height / 2;
  let best: { id: string; score: number } | null = null;
  for (const c of candidates) {
    const cx = c.rect.left + c.rect.width / 2;
    const cy = c.rect.top + c.rect.height / 2;
    let along: number;
    let across: number;
    switch (dir) {
      case 'up':
        along = from.top - c.rect.bottom;
        across = Math.abs(cx - fx);
        if (cy >= fy - 1) continue;
        break;
      case 'down':
        along = c.rect.top - from.bottom;
        across = Math.abs(cx - fx);
        if (cy <= fy + 1) continue;
        break;
      case 'left':
        along = from.left - c.rect.right;
        across = Math.abs(cy - fy);
        if (cx >= fx - 1) continue;
        break;
      case 'right':
        along = c.rect.left - from.right;
        across = Math.abs(cy - fy);
        if (cx <= fx + 1) continue;
        break;
    }
    const centreAlong = dir === 'up' || dir === 'down' ? Math.abs(cy - fy) : Math.abs(cx - fx);
    // Inside the cone of +-45 deg between the centres (rows of different widths still find each other).
    if (across > centreAlong + Math.min(from.width, from.height)) continue;
    const score = Math.max(0, along) + 2 * across;
    if (!best || score < best.score) best = { id: c.id, score };
  }
  return best?.id ?? null;
}

/** A device-pixel rectangle of a panel for the scrim step (the contract's UiScrimRect, structurally). */
export interface ScrimRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cornerRadius: number;
  blur: number;
  dim: number;
  opacity: number;
}

/** At most this many rectangles reach the scrim step (UI_SCRIM_SLOTS of the render contract). */
export const SCRIM_SLOTS = 8;

/**
 * The scrim rectangles of the visible panels under `root`, in the canvas's device pixels: every element with
 * `data-scrim` (its value is the blur 0..1), largest first, at most SCRIM_SLOTS; panels that do not fit merge
 * into the union of the last slot so none is left without its backdrop.
 */
export function scrimRectsOf(root: HTMLElement, canvasRect: DOMRect, dpr: number, opacity: number): ScrimRect[] {
  const out: ScrimRect[] = [];
  for (const e of Array.from(root.querySelectorAll<HTMLElement>('[data-scrim]'))) {
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    // What of the panel is seen: its box clipped by every scrolling ancestor (a long list or column scrolled).
    let left = r.left;
    let top = r.top;
    let right = r.right;
    let bottom = r.bottom;
    for (let a = e.parentElement; a && a !== root; a = a.parentElement) {
      if (a.scrollHeight <= a.clientHeight + 1 && a.scrollWidth <= a.clientWidth + 1) continue;
      const c = a.getBoundingClientRect();
      left = Math.max(left, c.left);
      top = Math.max(top, c.top);
      right = Math.min(right, c.right);
      bottom = Math.min(bottom, c.bottom);
    }
    const x0 = Math.max(0, (left - canvasRect.left) * dpr);
    const y0 = Math.max(0, (top - canvasRect.top) * dpr);
    const x1 = Math.min(canvasRect.width * dpr, (right - canvasRect.left) * dpr);
    const y1 = Math.min(canvasRect.height * dpr, (bottom - canvasRect.top) * dpr);
    if (x1 - x0 < 1 || y1 - y0 < 1) continue;
    out.push({ x0, y0, x1, y1, cornerRadius: 2 * dpr, blur: Number(e.dataset['scrim'] || '0.6'), dim: Number(e.dataset['scrimDim'] || '0.42'), opacity });
  }
  out.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  if (out.length <= SCRIM_SLOTS) return out;
  const keep = out.slice(0, SCRIM_SLOTS - 1);
  const rest = out.slice(SCRIM_SLOTS - 1);
  keep.push({ ...rest[0]!, x0: Math.min(...rest.map((r) => r.x0)), y0: Math.min(...rest.map((r) => r.y0)), x1: Math.max(...rest.map((r) => r.x1)), y1: Math.max(...rest.map((r) => r.y1)) });
  return keep;
}
