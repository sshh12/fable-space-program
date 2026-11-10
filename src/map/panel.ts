/**
 * The numeric maneuver-node panel: the three delta-v components, the total (rescales the burn, keeping its
 * direction), the node time as UT and as time from now ("1h 02m 03.4s", "T-90s", "1:30"), +/- one orbit,
 * delete, and previous/next node. A small DOM element positioned next to the selected node; all state
 * lives in the controller (panelState / panelSetValue / panelAction).
 *
 * Typing: Enter or leaving the field applies the value once; Escape restores the node's value. A field
 * whose text is unchanged sends nothing. Key events typed into the panel are stopped at the panel so
 * window-level key bindings never see them.
 */
import type { MapController, PanelField, PanelState } from './controller';
import { formatDuration, formatDurationField, parseDuration, parseNumber } from './format';

const STYLE = `
.fable-map-panel { position: absolute; z-index: 20; width: 232px; padding: 8px 10px 9px; box-sizing: border-box;
  background: rgba(10, 15, 22, 0.94); border: 1px solid rgba(80, 104, 136, 0.9); border-radius: 6px;
  font: 12px/1.35 Consolas, 'Cascadia Mono', ui-monospace, monospace; color: #e8eef7; user-select: none;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45); }
.fable-map-panel .hdr { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; color: #38d9e8; }
.fable-map-panel .row { display: grid; grid-template-columns: 72px 1fr 28px; align-items: center; gap: 4px; margin: 3px 0; }
.fable-map-panel .row span.u { color: #8b97a9; }
.fable-map-panel .row.pro span.k { color: #d7e85a; } .fable-map-panel .row.nrm span.k { color: #e35cf5; }
.fable-map-panel .row.rad span.k { color: #47c8ff; } .fable-map-panel .row.tot span.k, .fable-map-panel .row.time span.k { color: #aab6c8; }
.fable-map-panel .row.tot { margin-bottom: 7px; }
.fable-map-panel .row .wide { grid-column: 2 / 4; }
.fable-map-panel input { width: 100%; box-sizing: border-box; background: #05080d; color: #e8eef7; border: 1px solid #34465e;
  border-radius: 3px; padding: 2px 4px; font: inherit; text-align: right; }
.fable-map-panel input:focus { outline: none; border-color: #38d9e8; }
.fable-map-panel .btns { display: flex; gap: 5px; margin-top: 7px; }
.fable-map-panel button { flex: 1; background: #142030; color: #e8eef7; border: 1px solid #3a4e68; border-radius: 3px;
  padding: 3px 0; font: inherit; cursor: pointer; }
.fable-map-panel button:hover:not(:disabled) { background: #1d3048; border-color: #38d9e8; }
.fable-map-panel button:disabled { opacity: 0.4; cursor: default; }
.fable-map-panel .hdr button { flex: 0 0 22px; padding: 0; }
`;

const FIELDS: readonly PanelField[] = ['prograde', 'normal', 'radial', 'total', 'ut', 'timeTo'];

/** Text of a typed field -> value (NaN when it does not parse). */
const parseField = (field: PanelField, text: string): number => (field === 'timeTo' ? parseDuration(text) : parseNumber(text, field === 'ut' ? 's' : 'm/s'));

export class NodePanel {
  readonly element: HTMLDivElement;
  private readonly inputs: Record<PanelField, HTMLInputElement>;
  private readonly title: HTMLSpanElement;
  private readonly buttons: Record<'plusOrbit' | 'minusOrbit' | 'delete' | 'next' | 'previous', HTMLButtonElement>;
  /** Per field: the text that stands for the node's current value (last shown, or last applied by typing). */
  private readonly committed = new Map<PanelField, string>();
  private visible = false;
  private nodeId: string | null = null;

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
    el.innerHTML = `
      <div class="hdr"><button data-action="previous" title="Previous node">&lsaquo;</button><span class="title"></span><button data-action="next" title="Next node">&rsaquo;</button></div>
      <div class="row pro"><span class="k">Prograde</span>${input('prograde', 'Prograde delta-v, m/s')}<span class="u">m/s</span></div>
      <div class="row nrm"><span class="k">Normal</span>${input('normal', 'Normal delta-v, m/s')}<span class="u">m/s</span></div>
      <div class="row rad"><span class="k">Radial</span>${input('radial', 'Radial delta-v, m/s')}<span class="u">m/s</span></div>
      <div class="row tot"><span class="k">Total Δv</span>${input('total', 'Total delta-v, m/s: rescales the burn, keeping its direction')}<span class="u">m/s</span></div>
      <div class="row time"><span class="k">In</span>${input('timeTo', 'Time to the node: 1h 02m 03s, 1:02:03, 90 (seconds)', 'wide')}</div>
      <div class="row time"><span class="k">UT</span>${input('ut', 'Node time, s since J2000')}<span class="u">s</span></div>
      <div class="btns"><button data-action="minusOrbit" title="One orbit earlier">-1 orbit</button><button data-action="plusOrbit" title="One orbit later">+1 orbit</button><button data-action="delete" title="Delete node">Delete</button></div>`;
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
    this.setField('ut', st.ut.toFixed(1));
    this.setField('timeTo', st.timeTo >= 0 ? formatDurationField(st.timeTo) : `${formatDuration(st.timeTo)} ago`);
    this.buttons.plusOrbit.disabled = st.period === null;
    this.buttons.minusOrbit.disabled = !st.canMinusOrbit;
    this.buttons.next.disabled = st.count < 2;
    this.buttons.previous.disabled = st.count < 2;
    if (!this.visible) {
      this.element.style.display = 'block';
      this.visible = true;
      // Its real size, for the placement and for keeping map labels out from under it.
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
