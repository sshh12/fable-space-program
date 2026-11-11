/**
 * The numeric maneuver-node panel, in the flight HUD's type and panel style (theme.ts): the three delta-v
 * components, each between the two axis glyphs of the gizmo as nudge buttons (1 m/s per click, Shift 0.1,
 * Ctrl 10), the total (rescales the burn, keeping its direction), the node time as a countdown in the HUD's
 * notation ("T− 1:32:00.5"; typed also as "1h 30m", "90", "2d 03:04:05") and as calendar time in the HUD
 * clock's format ("2028-03-03 20:26:40" UTC; typed in the same form), +/- one orbit, delete, and
 * previous/next node. Every field is editable (the total and both times too). A DOM element placed by the
 * controller (off the trajectory and the gizmo); all state lives in the controller (panelState /
 * panelSetValue / panelNudge / panelAction). The panel is opaque: nothing shows through behind its fields.
 *
 * Typing: Enter or leaving the field applies the value once; Escape restores the node's value. A field
 * whose text is unchanged sends nothing. Key events typed into the panel are stopped at the panel so
 * window-level key bindings never see them.
 */
import type { DvComponent, MapController, PanelField, PanelState } from './controller';
import { formatDurationField, formatUtDate, parseDuration, parseNumber, parseUtDate } from './format';
import { HUD, MAP_FONT_FAMILY } from './theme';

/** Axis glyphs of the gizmo handles (gpu/shaders.ts shapes 14-19) as inline SVG, 14 px. */
const GLYPH: Record<string, string> = {
  prograde: '<circle cx="7" cy="7" r="3.6"/><circle cx="7" cy="7" r="0.9" fill="currentColor"/><path d="M1 7h2.4M10.6 7H13M7 1v2.4"/>',
  retrograde: '<circle cx="7" cy="7" r="3.6"/><path d="M5.2 5.2l3.6 3.6M8.8 5.2l-3.6 3.6M7 1v2.4M3.4 10.6L2 12M10.6 10.6L12 12"/>',
  normal: '<path d="M7 1.6l5.2 9H1.8z"/><circle cx="7" cy="7.6" r="0.9" fill="currentColor"/>',
  antinormal: '<path d="M7 12.4l5.2-9H1.8z"/><path d="M7 6.4v-3M7 6.4l-3.4 2M7 6.4l3.4 2"/>',
  radialOut: '<circle cx="7" cy="7" r="3"/><path d="M2.4 2.4l1.6 1.6M11.6 2.4L10 4M2.4 11.6L4 10M11.6 11.6L10 10"/>',
  radialIn: '<circle cx="7" cy="7" r="3"/><circle cx="7" cy="7" r="0.8" fill="currentColor"/><path d="M5.3 5.3l.9.9M8.7 5.3l-.9.9M5.3 8.7l.9-.9M8.7 8.7l-.9-.9"/>',
};
const svg = (name: string): string => `<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPH[name]}</svg>`;
const ICONS = {
  minusOrbit: '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M11.5 7A4.5 4.5 0 1 1 7 2.5"/><path d="M7 0.8L9 2.6 7 4.4"/></svg>',
  plusOrbit: '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M2.5 7A4.5 4.5 0 1 0 7 2.5"/><path d="M7 0.8L5 2.6 7 4.4"/></svg>',
  delete: '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.8h9M5.6 3.8V2.4h2.8v1.4M3.6 3.8l.6 7.8h5.6l.6-7.8M5.8 5.8v4M8.2 5.8v4"/></svg>',
};

/**
 * Sizes are written in interface px and multiplied by the custom property --mu (CSS px per interface px, the
 * map's interface scale: 1 at 720p, 1.5 at 1080p), so the panel keeps its size relative to the HUD beside it.
 */
const STYLE_UI = `
.fable-map-panel { position: absolute; z-index: 20; width: 248px; padding: 9px 10px 8px; box-sizing: border-box;
  background: ${HUD.panel}; border: 1px solid ${HUD.line}; border-radius: 7px;
  font: 600 13px/1.25 ${MAP_FONT_FAMILY}; font-variant-numeric: tabular-nums; color: ${HUD.text}; user-select: none;
  box-shadow: 0 3px 14px rgba(0, 0, 0, 0.45); }
.fable-map-panel * { box-sizing: border-box; }
.fable-map-panel .hdr { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; }
.fable-map-panel .cap { font-size: 10px; font-weight: 600; letter-spacing: 0.11em; text-transform: uppercase; color: ${HUD.label}; }
.fable-map-panel .hdr .cap { flex: 1; }
.fable-map-panel .hdr .title { color: ${HUD.accent}; letter-spacing: 0.04em; }
.fable-map-panel .row { display: grid; grid-template-columns: 58px 24px 1fr 24px 26px; align-items: center; gap: 3px; margin: 3px 0; }
.fable-map-panel .row .cap { display: flex; align-items: center; gap: 4px; }
.fable-map-panel .row .u { font-size: 11px; font-weight: 500; color: ${HUD.dim}; }
.fable-map-panel .row.pro .k { color: #d7e85a; } .fable-map-panel .row.nrm .k { color: #e35cf5; } .fable-map-panel .row.rad .k { color: #47c8ff; }
.fable-map-panel .row .span3 { grid-column: 2 / 5; }
.fable-map-panel .row .span4 { grid-column: 2 / 6; }
.fable-map-panel .sep { height: 1px; background: ${HUD.line}; margin: 6px 0 5px; }
.fable-map-panel input { width: 100%; min-width: 0; background: ${HUD.field}; color: ${HUD.text}; border: 1px solid ${HUD.fieldEdge};
  border-radius: 3px; padding: 2px 4px; font: inherit; text-align: right; font-variant-numeric: tabular-nums; }
.fable-map-panel input:focus { outline: none; border-color: ${HUD.accent}; }
.fable-map-panel button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 22px; padding: 0;
  background: #121b27; color: ${HUD.text}; border: 1px solid ${HUD.fieldEdge}; border-radius: 3px; font: inherit; font-size: 11px;
  letter-spacing: 0.05em; text-transform: uppercase; cursor: pointer; }
.fable-map-panel button:hover:not(:disabled) { background: #1a2738; border-color: ${HUD.accent}; }
.fable-map-panel button:disabled { opacity: 0.35; cursor: default; }
.fable-map-panel .row button { width: 24px; height: 24px; color: inherit; }
.fable-map-panel .row button svg { width: 16px; height: 16px; }
.fable-map-panel .row.pro button { color: #d7e85a; } .fable-map-panel .row.nrm button { color: #e35cf5; } .fable-map-panel .row.rad button { color: #47c8ff; }
.fable-map-panel .hdr button { flex: 0 0 22px; font-size: 14px; }
.fable-map-panel .btns { display: grid; grid-template-columns: 1fr 1fr 34px; gap: 5px; margin-top: 8px; }
.fable-map-panel .btns [data-action="delete"] { color: ${HUD.warning}; }
.fable-map-panel svg { width: 14px; height: 14px; }
.fable-map-panel .hint { margin-top: 6px; font-size: 10px; line-height: 1.35; font-weight: 500; letter-spacing: 0.04em; color: ${HUD.dim}; text-align: center; }
`;
const STYLE = STYLE_UI.replace(/(\d+(?:\.\d+)?)px/g, 'calc($1 * var(--mu, 1px))');

const FIELDS: readonly PanelField[] = ['prograde', 'normal', 'radial', 'total', 'ut', 'timeTo'];

/** Text of a typed field -> value (NaN when it does not parse). UT: a calendar time, or seconds since J2000. */
const parseField = (field: PanelField, text: string): number => {
  if (field === 'timeTo') return parseDuration(text);
  if (field === 'ut') {
    const date = parseUtDate(text);
    return Number.isFinite(date) ? date : parseNumber(text, 's');
  }
  return parseNumber(text, 'm/s');
};

export class NodePanel {
  readonly element: HTMLDivElement;
  private readonly inputs: Record<PanelField, HTMLInputElement>;
  private readonly title: HTMLSpanElement;
  private readonly buttons: Record<'plusOrbit' | 'minusOrbit' | 'delete' | 'next' | 'previous', HTMLButtonElement>;
  /** Per field: the text that stands for the node's current value (last shown, or last applied by typing). */
  private readonly committed = new Map<PanelField, string>();
  private visible = false;
  private nodeId: string | null = null;
  /** Interface scale the panel is laid out at (--mu). */
  private scale = 1;

  constructor(
    private readonly controller: MapController,
    root: HTMLElement,
    fixed: boolean,
  ) {
    const doc = root.ownerDocument;
    if (!doc.getElementById('fable-map-panel-style')) {
      const st = doc.createElement('style');
      st.id = 'fable-map-panel-style';
      st.textContent = STYLE;
      doc.head.appendChild(st);
    }
    const el = doc.createElement('div');
    el.className = 'fable-map-panel';
    el.dataset['mapPanel'] = '1';
    el.style.position = fixed ? 'fixed' : 'absolute';
    el.style.display = 'none';
    const input = (field: PanelField, title: string, cls = ''): string =>
      `<input data-field="${field}"${cls ? ` class="${cls}"` : ''} inputmode="decimal" spellcheck="false" autocomplete="off" title="${title}">`;
    const axisRow = (cls: string, comp: DvComponent, caption: string, minus: string, plus: string): string =>
      `<div class="row ${cls}"><span class="cap k">${caption}</span>` +
      `<button data-nudge="${comp}:-1" title="${caption}: -1 m/s (Shift 0.1, Ctrl 10)">${svg(minus)}</button>` +
      `${input(comp, `${caption} delta-v, m/s`)}` +
      `<button data-nudge="${comp}:1" title="${caption}: +1 m/s (Shift 0.1, Ctrl 10)">${svg(plus)}</button><span class="u">m/s</span></div>`;
    el.innerHTML = `
      <div class="hdr"><button data-action="previous" title="Previous node">&lsaquo;</button><span class="cap">Maneuver <span class="title"></span></span><button data-action="next" title="Next node">&rsaquo;</button></div>
      ${axisRow('pro', 'prograde', 'Prograde', 'retrograde', 'prograde')}
      ${axisRow('nrm', 'normal', 'Normal', 'antinormal', 'normal')}
      ${axisRow('rad', 'radial', 'Radial', 'radialIn', 'radialOut')}
      <div class="row tot"><span class="cap">Total Δv</span>${input('total', 'Total delta-v, m/s: rescales the burn, keeping its direction', 'span3')}<span class="u">m/s</span></div>
      <div class="sep"></div>
      <div class="row time"><span class="cap">In</span>${input('timeTo', 'Time to the node: T− 1:02:03, 1h 02m 03s, 90 (seconds)', 'span4')}</div>
      <div class="row time"><span class="cap">UT</span>${input('ut', 'Node time (UTC): 2028-03-03 20:26:40', 'span3')}<span class="u">UTC</span></div>
      <div class="btns"><button data-action="minusOrbit" title="One orbit earlier">${ICONS.minusOrbit}<span>&minus;1 orbit</span></button><button data-action="plusOrbit" title="One orbit later"><span>+1 orbit</span>${ICONS.plusOrbit}</button><button data-action="delete" title="Delete node">${ICONS.delete}</button></div>
      <div class="hint">Drag a handle &middot; Wheel 0.1 m/s<br>Shift fine &middot; Ctrl coarse</div>`;
    root.appendChild(el);
    this.element = el;
    const q = <T extends Element>(sel: string): T => el.querySelector(sel) as T;
    this.inputs = Object.fromEntries(FIELDS.map((f) => [f, q<HTMLInputElement>(`input[data-field="${f}"]`)])) as Record<PanelField, HTMLInputElement>;
    this.title = q('.title');
    this.buttons = {
      plusOrbit: q('button[data-action="plusOrbit"]'),
      minusOrbit: q('button[data-action="minusOrbit"]'),
      delete: q('button[data-action="delete"]'),
      next: q('button[data-action="next"]'),
      previous: q('button[data-action="previous"]'),
    };
    for (const [name, b] of Object.entries(this.buttons)) {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.controller.panelAction(name as keyof NodePanel['buttons']);
      });
    }
    for (const b of el.querySelectorAll<HTMLButtonElement>('button[data-nudge]')) {
      const [comp, sign] = b.dataset['nudge']!.split(':') as [DvComponent, string];
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.controller.panelNudge(comp, sign === '1' ? 1 : -1, e.shiftKey ? 0.1 : e.ctrlKey ? 10 : 1);
      });
    }
    for (const field of FIELDS) {
      const input = this.inputs[field];
      // Applies the typed text once: unchanged text (nothing typed, or already applied by Enter) sends no
      // command; text that does not parse or is refused shows the node's value again.
      const apply = (): void => {
        const text = input.value.trim();
        if (text === this.committed.get(field)) return;
        const value = parseField(field, text);
        if (Number.isFinite(value) && this.controller.panelSetValue(field, value)) this.committed.set(field, text);
        else input.value = this.committed.get(field) ?? '';
      };
      input.addEventListener('change', apply);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          apply();
          input.select();
        } else if (e.key === 'Escape') {
          // Revert before leaving the field, so the change event that blur fires finds nothing to apply.
          input.value = this.committed.get(field) ?? '';
          input.blur();
        }
      });
    }
    // Typing must not reach the flight key bindings; pointer events must not reach the scene.
    for (const type of ['keydown', 'keyup', 'keypress'] as const) el.addEventListener(type, (e) => e.stopPropagation());
    el.addEventListener('pointerenter', () => this.controller.setPanelHover(true));
    el.addEventListener('pointerleave', () => this.controller.setPanelHover(false));
    el.addEventListener('focusin', () => this.controller.setPanelFocus(true));
    el.addEventListener('focusout', () => {
      queueMicrotask(() => this.controller.setPanelFocus(el.contains(doc.activeElement)));
    });
    el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  }

  /** Mirror the controller's panel state into the DOM (the field being edited is left alone). */
  sync(st: PanelState | null): void {
    if (!st) {
      if (this.visible) {
        this.element.style.display = 'none';
        this.visible = false;
        this.controller.setPanelHover(false);
        if (this.element.contains(this.element.ownerDocument.activeElement)) (this.element.ownerDocument.activeElement as HTMLElement).blur();
        this.controller.setPanelFocus(false);
      }
      return;
    }
    if (this.nodeId !== st.nodeId) {
      this.nodeId = st.nodeId;
      this.committed.clear();
    }
    this.element.style.left = `${Math.round(st.x)}px`;
    this.element.style.top = `${Math.round(st.y)}px`;
    this.setText(this.title, `Node ${st.index + 1} / ${st.count}`);
    this.setField('prograde', st.dv.prograde.toFixed(1));
    this.setField('normal', st.dv.normal.toFixed(1));
    this.setField('radial', st.dv.radial.toFixed(1));
    this.setField('total', st.total.toFixed(1));
    this.setField('ut', formatUtDate(st.ut));
    this.setField('timeTo', formatDurationField(st.timeTo));
    this.buttons.plusOrbit.disabled = st.period === null;
    this.buttons.minusOrbit.disabled = !st.canMinusOrbit;
    this.buttons.next.disabled = st.count < 2;
    this.buttons.previous.disabled = st.count < 2;
    const rescaled = st.scale !== this.scale;
    if (rescaled) {
      this.scale = st.scale;
      this.element.style.setProperty('--mu', `${st.scale}px`);
    }
    if (!this.visible || rescaled) {
      this.element.style.display = 'block';
      this.visible = true;
      // Its real size (CSS px), for the placement and for keeping map labels out from under it.
      this.controller.setPanelSize(this.element.offsetWidth, this.element.offsetHeight);
    }
  }

  dispose(): void {
    this.element.remove();
  }

  private setText(el: HTMLElement, text: string): void {
    if (el.textContent !== text) el.textContent = text;
  }

  private setField(field: PanelField, text: string): void {
    const input = this.inputs[field];
    if (input.ownerDocument.activeElement === input) return;
    if (this.committed.get(field) === text && input.value === text) return;
    input.value = text;
    this.committed.set(field, text);
  }
}
