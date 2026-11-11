/**
 * Minimal DOM helpers for the HUD: element construction and change-only writers, so a frame that changes
 * nothing touches nothing (no style recalculation, no layout).
 */

/**
 * Marks the HUD parts that take pointer events (the stylesheet gives exactly these `pointer-events: auto`);
 * everything else lets the pointer through to the scene canvas. The input system reports the pointer over any
 * of them as PointerState.overUi (it is over an element other than the canvas).
 */
export const INTERACTIVE_ATTR = 'data-hud-interactive';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', children: (Node | string)[] = [], attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}

/** A text node that only writes when the string changes. */
export class TextSlot {
  readonly node: Text;
  private cur: string;
  constructor(initial = '') {
    this.cur = initial;
    this.node = document.createTextNode(initial);
  }
  set(s: string): void {
    if (s !== this.cur) {
      this.cur = s;
      this.node.data = s;
    }
  }
  get value(): string {
    return this.cur;
  }
}

/** Change-only boolean writer (class toggle, hidden flag, attribute). */
export class Flag {
  private cur: boolean | null = null;
  constructor(private readonly apply: (on: boolean) => void) {}
  set(on: boolean): void {
    if (on !== this.cur) {
      this.cur = on;
      this.apply(on);
    }
  }
}

export const classFlag = (e: Element, cls: string): Flag => new Flag((on) => e.classList.toggle(cls, on));
export const hiddenFlag = (e: HTMLElement): Flag => new Flag((on) => (e.hidden = !on));

/** Change-only string writer for a class set from a fixed list (tones). */
export class ToneSlot {
  private cur = '';
  constructor(private readonly e: Element) {}
  set(tone: string): void {
    if (tone === this.cur) return;
    if (this.cur) this.e.classList.remove(`t-${this.cur}`);
    if (tone) this.e.classList.add(`t-${tone}`);
    this.cur = tone;
  }
}

/** Fill element of a bar / tube scaled with a transform (compositor-only). */
export class FillSlot {
  private cur = -1;
  constructor(
    private readonly e: HTMLElement,
    private readonly axis: 'x' | 'y',
  ) {}
  set(frac: number): void {
    const f = Math.round(Math.max(0, Math.min(1, frac)) * 1000) / 1000;
    if (f === this.cur) return;
    this.cur = f;
    this.e.style.transform = this.axis === 'x' ? `scaleX(${f})` : `scaleY(${f})`;
  }
}

/**
 * Tape-gauge fill that reveals a scale-fixed colour layer: the window is translated down by (1 - f) of its
 * height and the colour layer inside it back up by the same amount, so the colours stay where the scale puts
 * them while the fill moves. Two composited transforms, no layout and no paint.
 */
export class RevealSlot {
  private cur = -1;
  constructor(
    private readonly win: HTMLElement,
    private readonly layer: HTMLElement,
  ) {}
  set(frac: number): void {
    const f = Math.round(Math.max(0, Math.min(1, frac)) * 1000) / 1000;
    if (f === this.cur) return;
    this.cur = f;
    const off = Math.round((1 - f) * 1000) / 10;
    this.win.style.transform = `translateY(${off}%)`;
    this.layer.style.transform = `translateY(${-off}%)`;
  }
}

/** A string attribute written only when it changes. */
export class AttrSlot {
  private cur: string | null = null;
  constructor(
    private readonly e: Element,
    private readonly name: string,
  ) {}
  set(v: string): void {
    if (v === this.cur) return;
    this.cur = v;
    this.e.setAttribute(this.name, v);
  }
}

export function bar(cls = ''): { root: HTMLDivElement; fill: FillSlot; tone: Flag[] } {
  const fillEl = el('i');
  const root = el('div', `bar ${cls}`.trim(), [fillEl]);
  return { root, fill: new FillSlot(fillEl, 'x'), tone: [] };
}

/** A button that never takes focus (Space and Enter stay with the game) and fires `onClick`. */
export function hudButton(content: (Node | string)[], cls: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, content, { type: 'button', tabindex: '-1', title, [INTERACTIVE_ATTR]: '' });
  b.addEventListener('pointerdown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => {
    e.preventDefault();
    if (b.getAttribute('aria-disabled') === 'true') return;
    onClick();
  });
  return b;
}
