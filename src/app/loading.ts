/**
 * The loading screen of the app shell: what is being loaded and how far along it is, from the moment the page
 * opens until the view at the start position is final (game.ts decides that; see `viewFinal` there).
 *
 * Every number on it is read from the subsystem that does the work: files of the definitions read, render
 * features initialised, shader modules still compiling, parts of the sky data resident, sound assets decoded,
 * terrain tiles resident / queued / baking / uploading and the deepest level drawn. A step whose subsystem
 * exposes no count shows its phase only (no percentage is made up), and nothing here runs on a timer: a bar
 * moves when its count moves. The elapsed time in the footer is the wall clock since the page was opened.
 *
 * The screen covers the canvas and the HUD (the scene renders underneath: streaming, shader warm-up and the
 * exposure meter need real frames) and is faded out by the frame loop once the view is final. It is drawn in
 * the HUD's type and colours (src/core/ui/theme.ts) and its interface unit (1 % of the height of a 16:9 frame).
 */
import { UI_COLORS, UI_FONT_FAMILY } from '@/core/ui/theme';

export const LOAD_STEPS = [
  ['gpu', 'Graphics device'],
  ['defs', 'Definitions'],
  ['sim', 'Simulation'],
  ['pipelines', 'Render pipelines'],
  ['sky', 'Sky and stars'],
  ['atmosphere', 'Atmosphere and clouds'],
  ['models', 'Vehicle and site models'],
  ['audio', 'Sound'],
  ['terrain', 'Terrain at the start'],
  ['view', 'First frames'],
] as const;

export type LoadStepId = (typeof LOAD_STEPS)[number][0];
export type LoadStepState = 'waiting' | 'active' | 'done';

/** Fade from the loading screen to the scene, ms. */
export const REVEAL_FADE_MS = 450;
/** How often the watched steps are re-read while no frame loop runs yet, ms (a poll rate, not a progress clock). */
const REFRESH_MS = 100;

export interface StepProgress {
  /** What is happening, in words. */
  detail?: string;
  /** A real count and its total; null = the subsystem exposes none (the step shows its phase only). */
  done?: number | null;
  total?: number | null;
}

export interface LoadStepReport {
  id: LoadStepId;
  label: string;
  state: LoadStepState;
  detail: string;
  done: number | null;
  total: number | null;
  /** performance.now() when the step began / finished, ms (null = not yet). */
  startMs: number | null;
  endMs: number | null;
}

/** What the frame loop found when it decided the view was final. */
export interface RevealRecord {
  /** Frames presented under the loading screen before the fade began. */
  frame: number;
  /** performance.now() at the start and the end of the fade, ms (end null while fading). */
  startMs: number;
  endMs: number | null;
  /** Render features that still reported work (empty, or the terrain when its tile pool is full: see `terrain`). */
  busy: string[];
  /** The terrain's stream counters and the deepest level drawn at that moment. */
  terrain: { resident: number; queued: number; baking: number; uploading: number; poolFull: boolean; deepestLevel: number; levelUnderVehicle: number | null };
  /** Exposure: metered EV100 and its target. */
  ev100: number;
  targetEv100: number;
  /** Consecutive final frames that were required and seen. */
  settledFrames: number;
}

export interface LoadingReport {
  /** The screen covers the scene (true until the fade has finished). */
  active: boolean;
  fading: boolean;
  opacity: number;
  /** Time since the page was opened (performance.now()), ms; stops when the screen has gone. */
  elapsedMs: number;
  steps: LoadStepReport[];
  reveal: RevealRecord | null;
}

export interface LoadingScreen {
  readonly element: HTMLElement;
  readonly active: boolean;
  /** The fade to the scene is running. */
  readonly fading: boolean;
  /** Resolves when the fade has finished and the screen is gone. */
  readonly revealed: Promise<void>;
  setHeading(title: string, subtitle: string): void;
  /** waiting -> active (no effect on a step that has begun). */
  begin(id: LoadStepId, progress?: StepProgress): void;
  /** New numbers or words for a step that is not finished. */
  update(id: LoadStepId, progress: StepProgress): void;
  /** -> done, once: a finished step keeps its last numbers. */
  finish(id: LoadStepId, progress?: StepProgress): void;
  /** Read the step's numbers from its subsystem at every refresh while it is active. */
  watch(id: LoadStepId, read: () => StepProgress): void;
  state(id: LoadStepId): LoadStepState;
  /** Re-read the watched steps and repaint what changed. */
  refresh(): void;
  /** The view is final: start the fade. */
  reveal(record: Omit<RevealRecord, 'startMs' | 'endMs'>): void;
  /** Once per frame: advances the fade; removes the screen when it has finished. */
  frame(now: number): void;
  /** Boot failed: take the screen away (the page's error box shows instead). */
  abort(): void;
  report(): LoadingReport;
}

const U = 'min(1vh, 0.5625vw)';
const u = (k: number): string => `calc(${U} * ${k})`;

const CSS = `
[data-app-loading] { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(120% 90% at 50% 30%, #0c1522 0%, #070b12 55%, #04060a 100%); color: ${UI_COLORS.text};
  font-family: ${UI_FONT_FAMILY}; font-variant-numeric: tabular-nums; font-size: ${u(1.75)}; line-height: 1.25; pointer-events: auto; user-select: none; }
[data-app-loading] .col { width: ${u(92)}; max-width: 92vw; }
[data-app-loading] .kicker { font-size: ${u(1.5)}; letter-spacing: 0.24em; color: ${UI_COLORS.accent}; text-transform: uppercase; }
[data-app-loading] .title { font-size: ${u(3.3)}; font-weight: 600; margin-top: ${u(0.9)}; }
[data-app-loading] .sub { font-size: ${u(1.85)}; color: ${UI_COLORS.label}; margin-top: ${u(0.4)}; min-height: ${u(2.4)}; }
[data-app-loading] .rows { margin-top: ${u(2.6)}; border-bottom: 1px solid ${UI_COLORS.line}; }
[data-app-loading] .row { display: grid; grid-template-columns: ${u(2.4)} ${u(25)} 1fr auto; align-items: center; column-gap: ${u(0.8)};
  padding: ${u(0.95)} 0 ${u(0.7)}; min-height: ${u(2.3)}; border-top: 1px solid ${UI_COLORS.line}; position: relative; }
[data-app-loading] .mark { width: ${u(0.95)}; height: ${u(0.95)}; border-radius: 50%; border: 1px solid ${UI_COLORS.dim}; box-sizing: border-box; justify-self: center; }
[data-app-loading] .label { letter-spacing: 0.1em; text-transform: uppercase; color: ${UI_COLORS.dim}; font-size: ${u(1.55)}; white-space: nowrap; }
[data-app-loading] .detail { color: ${UI_COLORS.dim}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
[data-app-loading] .count { color: ${UI_COLORS.dim}; white-space: nowrap; padding-left: ${u(1.2)}; }
[data-app-loading] .bar { position: absolute; left: 0; right: 0; bottom: -1px; height: ${u(0.22)}; }
[data-app-loading] .fill { height: 100%; width: 0; background: ${UI_COLORS.accent}; }
[data-app-loading] .row[data-state='active'] .mark { background: ${UI_COLORS.accent}; border-color: ${UI_COLORS.accent}; box-shadow: 0 0 ${u(0.9)} ${UI_COLORS.accent}; }
[data-app-loading] .row[data-state='active'] .label { color: ${UI_COLORS.text}; }
[data-app-loading] .row[data-state='active'] .detail, [data-app-loading] .row[data-state='active'] .count { color: ${UI_COLORS.label}; }
[data-app-loading] .row[data-state='done'] .mark { background: ${UI_COLORS.good}; border-color: ${UI_COLORS.good}; }
[data-app-loading] .row[data-state='done'] .label { color: ${UI_COLORS.label}; }
[data-app-loading] .row[data-state='done'] .fill { background: ${UI_COLORS.good}; opacity: 0.55; }
[data-app-loading] .foot { display: flex; justify-content: space-between; gap: ${u(2)}; margin-top: ${u(1.5)}; color: ${UI_COLORS.label}; font-size: ${u(1.6)}; }
[data-app-loading] .foot .clock { color: ${UI_COLORS.text}; white-space: nowrap; }
`;

interface Row {
  id: LoadStepId;
  label: string;
  state: LoadStepState;
  detail: string;
  done: number | null;
  total: number | null;
  startMs: number | null;
  endMs: number | null;
  read: (() => StepProgress) | null;
  root: HTMLElement;
  detailEl: HTMLElement;
  countEl: HTMLElement;
  fillEl: HTMLElement;
  painted: string;
}

const formatCount = (n: number): string => Math.round(n).toLocaleString('en-US');

function formatClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function createLoadingScreen(container: HTMLElement): LoadingScreen {
  const style = document.createElement('style');
  style.textContent = CSS;
  const el = document.createElement('div');
  // The page's static first paint (index.html) covers the time until this module runs; this screen replaces it.
  document.getElementById('boot-splash')?.remove();
  el.setAttribute('data-app-loading', 'active');
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  const div = (cls: string, text = ''): HTMLDivElement => {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    return d;
  };
  const col = div('col');
  const kicker = div('kicker', document.title.split(' - ')[0] ?? '');
  const title = div('title', 'Starting');
  const sub = div('sub');
  const rowsEl = div('rows');
  const rows: Row[] = LOAD_STEPS.map(([id, label]) => {
    const root = div('row');
    root.dataset['step'] = id;
    root.dataset['state'] = 'waiting';
    const detailEl = div('detail');
    const countEl = div('count');
    const bar = div('bar');
    const fillEl = div('fill');
    bar.append(fillEl);
    root.append(div('mark'), div('label', label), detailEl, countEl, bar);
    rowsEl.append(root);
    return { id, label, state: 'waiting', detail: '', done: null, total: null, startMs: null, endMs: null, read: null, root, detailEl, countEl, fillEl, painted: '' };
  });
  const foot = div('foot');
  const waiting = div('', 'The view opens when everything it shows at the start position is loaded.');
  const clock = div('clock');
  foot.append(waiting, clock);
  col.append(kicker, title, sub, rowsEl, foot);
  el.append(style, col);
  container.append(el);

  let phase: 'loading' | 'fading' | 'gone' = 'loading';
  let opacity = 1;
  let reveal: RevealRecord | null = null;
  let resolveRevealed!: () => void;
  const revealed = new Promise<void>((r) => {
    resolveRevealed = r;
  });
  let clockText = '';

  const rowOf = (id: LoadStepId): Row => rows.find((r) => r.id === id)!;

  const apply = (row: Row, p: StepProgress | undefined): void => {
    if (!p) return;
    if (p.detail !== undefined) row.detail = p.detail;
    if (p.done !== undefined) row.done = p.done;
    if (p.total !== undefined) row.total = p.total;
  };

  const paint = (row: Row): void => {
    const counted = row.done !== null && row.total !== null && row.total > 0;
    const fraction = row.state === 'done' ? 1 : counted ? Math.min(1, Math.max(0, row.done! / row.total!)) : 0;
    const count = counted ? `${formatCount(row.done!)} / ${formatCount(row.total!)}` : '';
    const key = `${row.state}|${row.detail}|${count}|${fraction.toFixed(4)}`;
    if (key === row.painted) return;
    row.painted = key;
    row.root.dataset['state'] = row.state;
    row.detailEl.textContent = row.detail;
    row.countEl.textContent = count;
    // A bar only where there is a count behind it (and for a finished step).
    row.fillEl.style.width = counted || row.state === 'done' ? `${(fraction * 100).toFixed(2)}%` : '0';
  };

  const refresh = (): void => {
    if (phase === 'gone') return;
    for (const row of rows) {
      if (row.state === 'active' && row.read) apply(row, row.read());
      paint(row);
    }
    const text = formatClock(performance.now());
    if (text !== clockText) {
      clockText = text;
      clock.textContent = text;
    }
  };
  refresh();
  const timer = window.setInterval(refresh, REFRESH_MS);

  const remove = (): void => {
    if (phase === 'gone') return;
    phase = 'gone';
    opacity = 0;
    window.clearInterval(timer);
    el.remove();
    resolveRevealed();
  };

  return {
    element: el,
    get active() {
      return phase !== 'gone';
    },
    get fading() {
      return phase === 'fading';
    },
    revealed,
    setHeading(t, s) {
      title.textContent = t;
      sub.textContent = s;
    },
    begin(id, progress) {
      const row = rowOf(id);
      if (row.state !== 'waiting') return;
      row.state = 'active';
      row.startMs = performance.now();
      apply(row, progress);
      paint(row);
    },
    update(id, progress) {
      const row = rowOf(id);
      if (row.state === 'done') return;
      apply(row, progress);
      paint(row);
    },
    finish(id, progress) {
      const row = rowOf(id);
      if (row.state === 'done') return;
      if (row.startMs === null) row.startMs = performance.now();
      if (row.read) apply(row, row.read());
      apply(row, progress);
      row.state = 'done';
      row.endMs = performance.now();
      paint(row);
    },
    watch(id, read) {
      rowOf(id).read = read;
    },
    state: (id) => rowOf(id).state,
    refresh,
    reveal(record) {
      if (phase !== 'loading') return;
      phase = 'fading';
      reveal = { ...record, startMs: performance.now(), endMs: null };
      el.setAttribute('data-app-loading', 'fading');
      el.style.pointerEvents = 'none';
      refresh();
    },
    frame(now) {
      if (phase !== 'fading' || !reveal) return;
      opacity = Math.min(1, Math.max(0, 1 - (now - reveal.startMs) / REVEAL_FADE_MS));
      el.style.opacity = opacity.toFixed(3);
      if (opacity <= 0) {
        reveal.endMs = now;
        remove();
      }
    },
    abort: remove,
    report: () => {
      // Current numbers, not the last repaint's.
      if (phase === 'loading') refresh();
      return report();
    },
  };

  function report(): LoadingReport {
    return {
      active: phase !== 'gone',
      fading: phase === 'fading',
      opacity,
      elapsedMs: reveal?.endMs ?? performance.now(),
      steps: rows.map((r) => ({ id: r.id, label: r.label, state: r.state, detail: r.detail, done: r.done, total: r.total, startMs: r.startMs, endMs: r.endMs })),
      reveal: reveal ? { ...reveal, busy: [...reveal.busy], terrain: { ...reveal.terrain } } : null,
    };
  }
}
