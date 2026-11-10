/**
 * The lab's own PointerState source (the lab may not import src/input): DOM pointer, wheel, double-click
 * and modifier-key events accumulated between frames, in CSS pixels relative to the canvas.
 */
import type { PointerState } from '@/core/contracts/controls';

export class LabPointer {
  private x = 0;
  private y = 0;
  private dx = 0;
  private dy = 0;
  private buttons = 0;
  private pressed = false;
  private released = false;
  private doubleClick = false;
  private wheel = 0;
  private shift = false;
  private ctrl = false;
  private alt = false;
  private overUi = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const pos = (e: PointerEvent | MouseEvent): void => {
      const r = canvas.getBoundingClientRect();
      const nx = e.clientX - r.left;
      const ny = e.clientY - r.top;
      this.dx += nx - this.x;
      this.dy += ny - this.y;
      this.x = nx;
      this.y = ny;
      this.shift = e.shiftKey;
      this.ctrl = e.ctrlKey;
      this.alt = e.altKey;
      this.overUi = e.target !== canvas && !(this.buttons & 1);
    };
    window.addEventListener('pointermove', pos);
    canvas.addEventListener('pointerdown', (e) => {
      pos(e);
      this.overUi = false;
      if (e.button === 0) this.pressed = true;
      this.buttons = e.buttons;
      canvas.setPointerCapture(e.pointerId);
      canvas.focus();
    });
    window.addEventListener('pointerup', (e) => {
      pos(e);
      if (e.button === 0 && (this.buttons & 1)) this.released = true;
      this.buttons = e.buttons;
    });
    canvas.addEventListener('dblclick', (e) => {
      pos(e);
      this.doubleClick = true;
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        pos(e);
        this.wheel += e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0;
      },
      { passive: false },
    );
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    const keys = (e: KeyboardEvent): void => {
      this.shift = e.shiftKey;
      this.ctrl = e.ctrlKey;
      this.alt = e.altKey;
    };
    window.addEventListener('keydown', keys);
    window.addEventListener('keyup', keys);
  }

  /** The state of this frame; edges and deltas are reset afterwards. */
  sample(): PointerState {
    const s: PointerState = {
      x: this.x,
      y: this.y,
      dx: this.dx,
      dy: this.dy,
      buttons: this.buttons,
      pressed: this.pressed,
      released: this.released,
      doubleClick: this.doubleClick,
      wheel: this.wheel,
      shift: this.shift,
      ctrl: this.ctrl,
      alt: this.alt,
      overUi: this.overUi,
    };
    this.dx = 0;
    this.dy = 0;
    this.pressed = false;
    this.released = false;
    this.doubleClick = false;
    this.wheel = 0;
    return s;
  }
}
