/**
 * Helpers of the menu specs (shell-menu): the lab's hooks, key presses that close the loop on the state and the
 * focus, and the contrast of every text box over what is behind it.
 */
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { assertDiscreteGpu, openPage, saveScreenshot } from '../harness';

export interface Hooks {
  state: string;
  main: string;
  side: string[];
  focus: string | null;
  scrimRects: number;
  spawn: string;
  practice: boolean;
  textRefreshes: number;
  screenChanges: number;
}

export interface LastTransit {
  steps: number[];
  bounds: number[];
  frameMs: number[];
  handOverEv: number | null;
  /** The meter's target at the hand-over (what the view there would settle to). */
  handOverTarget: number | null;
  secondsSince: number | null;
  evNow: number;
}

declare global {
  interface Window {
    __shell?: {
      hooks(): Hooks;
      transit(): { u: number; holding: boolean; steps: number[]; acknowledged: boolean } | null;
      lastTransit(): LastTransit | null;
      setMenuHidden(on: boolean): void;
      exposure(): { ev100: number; targetEv100: number };
      fixture: { setLink(s: string, r?: string | null): void };
    };
  }
}

export const hooks = (page: Page): Promise<Hooks> => page.evaluate(() => window.__shell!.hooks());
export const waitState = (page: Page, state: string, timeout = 120_000): Promise<unknown> => page.waitForFunction((s) => window.__shell?.hooks().state === s, state, { timeout });
export const waitMain = (page: Page, main: string, timeout = 120_000): Promise<unknown> => page.waitForFunction((m) => window.__shell?.hooks().main === m, main, { timeout });
export const settle = (page: Page, frames = 40): Promise<void> => page.evaluate((n) => window.__test!.waitFrames(n), frames);

export async function shot(page: Page, name: string): Promise<void> {
  await settle(page);
  await saveScreenshot(page, 'shell-menu', name);
}

/** Wait for the focus: an id, or a prefix ending in '-*'. */
export async function waitFocus(page: Page, focus: string): Promise<void> {
  await page.waitForFunction(
    (f) => {
      const id = window.__shell!.hooks().focus ?? '';
      return f.endsWith('-*') ? id.startsWith(f.slice(0, -1)) : id === f;
    },
    focus,
    { timeout: 10_000 },
  );
}

/** Press a key; then wait for the state and for the focus. */
export async function press(page: Page, key: string, state?: string, focus?: string): Promise<void> {
  await page.keyboard.press(key);
  if (state) await waitState(page, state);
  if (focus !== undefined) await waitFocus(page, focus);
}

/** Click a control of the shell by its focus id (the pointer moves the focus there first); then wait for the state. */
export async function click(page: Page, focusId: string, state?: string): Promise<void> {
  const target = page.locator(`[data-focus="${focusId}"]`);
  await target.hover();
  await waitFocus(page, focusId);
  await target.click();
  if (state) await waitState(page, state);
}

/** Click the prompt bar's entry whose words are `text` (Back, Select, ...). */
export async function clickPrompt(page: Page, text: string, state?: string): Promise<void> {
  await page.locator('.sh-prompts .sh-prompt', { hasText: text }).first().click();
  if (state) await waitState(page, state);
}

export async function openLab(page: Page, query = ''): Promise<void> {
  await openPage(page, `/labs/shell/?governor=off${query}`, { timeoutMs: 600_000 });
  await assertDiscreteGpu(page);
  await waitState(page, 'title');
  await page.waitForFunction(() => document.querySelector('.sh-begin .sh-label')?.textContent === 'Press any key to begin', undefined, { timeout: 600_000 });
}

// ------------------------------------------------------------------------------------------- contrast

/** One run of text as drawn: its tight rectangles (CSS px), its colour (sRGB 0..255, alpha 0..1 with the ancestors' opacity). */
interface TextBox {
  text: string;
  rects: { x: number; y: number; w: number; h: number }[];
  rgba: [number, number, number, number];
  px: number;
  disabled: boolean;
}

export interface ContrastResult {
  text: string;
  /** Text of a disabled control (WCAG 1.4.3 exempts inactive components): reported, not held to the ratio. */
  disabled: boolean;
  /** Contrast ratio at the 2nd percentile of the pixels behind the text (98 % of them give at least this), and at the worst pixel. */
  p2: number;
  min: number;
  px: number;
}

const lin = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (r: number, g: number, b: number): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * The contrast of every visible text of the shell over what is behind it: the text is made transparent (and its
 * shadow removed: WCAG does not count it), the page is captured `frames` times over `spanFrames` frames of the
 * live backdrop, and each text's colour is set against every pixel inside its rectangles in every capture.
 * The panels, the scrim and the vignette are in the captures: they are what the text is read against.
 */
export async function textContrast(page: Page, opts: { captures?: number; spanFrames?: number; save?: string } = {}): Promise<ContrastResult[]> {
  const boxes = await page.evaluate(() => {
    const out: { text: string; rects: { x: number; y: number; w: number; h: number }[]; rgba: [number, number, number, number]; px: number; disabled: boolean }[] = [];
    const root = document.querySelector('.sh-root');
    if (!root || (root as HTMLElement).hidden) return out;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parse = (c: string): [number, number, number, number] => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return [255, 255, 255, 1];
      const p = m[1]!.split(/[,\s/]+/).filter(Boolean).map(Number);
      return [p[0] ?? 255, p[1] ?? 255, p[2] ?? 255, p[3] ?? 1];
    };
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = (n.textContent ?? '').trim();
      const host = n.parentElement;
      if (!t || !host) continue;
      const cs = getComputedStyle(host);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      let opacity = 1;
      for (let e: Element | null = host; e && e !== document.body; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
      if (opacity < 0.05) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const rects = Array.from(range.getClientRects())
        .filter((r) => r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.left < innerWidth && r.top < innerHeight)
        .map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }));
      if (rects.length === 0) continue;
      const rgba = parse(cs.color);
      rgba[3] *= opacity;
      out.push({ text: t.slice(0, 60), rects, rgba, px: parseFloat(cs.fontSize), disabled: host.closest('[aria-disabled="true"]') !== null });
    }
    return out;
  });
  const captures = opts.captures ?? 4;
  const span = opts.spanFrames ?? 90;
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.dataset['contrast'] = '1';
    s.textContent = '.sh-root, .sh-root * { color: transparent !important; text-shadow: none !important; caret-color: transparent !important; -webkit-text-fill-color: transparent !important; }';
    document.head.append(s);
  });
  await page.evaluate(() => window.__test!.waitFrames(3));
  const images: PNG[] = [];
  for (let i = 0; i < captures; i++) {
    if (i > 0) await page.evaluate((n) => window.__test!.waitFrames(n), Math.max(1, Math.round(span / Math.max(1, captures - 1))));
    const buf = opts.save && i === 0 ? (await saveScreenshot(page, 'shell-menu', opts.save)).buffer : await page.screenshot();
    images.push(PNG.sync.read(buf));
  }
  await page.evaluate(() => document.querySelector('style[data-contrast="1"]')?.remove());
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
  const results: ContrastResult[] = [];
  for (const b of boxes as TextBox[]) {
    const ratios: number[] = [];
    for (const img of images) {
      for (const r of b.rects) {
        const x0 = Math.max(0, Math.floor(r.x * dpr));
        const y0 = Math.max(0, Math.floor(r.y * dpr));
        const x1 = Math.min(img.width, Math.ceil((r.x + r.w) * dpr));
        const y1 = Math.min(img.height, Math.ceil((r.y + r.h) * dpr));
        const stride = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 4000)));
        for (let y = y0; y < y1; y += stride) {
          for (let x = x0; x < x1; x += stride) {
            const i = (y * img.width + x) * 4;
            const br = img.data[i]!;
            const bg = img.data[i + 1]!;
            const bb = img.data[i + 2]!;
            // The text's colour over this pixel (its alpha composited in sRGB, as the browser blends).
            const a = b.rgba[3];
            const tr = b.rgba[0] * a + br * (1 - a);
            const tg = b.rgba[1] * a + bg * (1 - a);
            const tb = b.rgba[2] * a + bb * (1 - a);
            ratios.push(ratio(luminance(tr, tg, tb), luminance(br, bg, bb)));
          }
        }
      }
    }
    if (ratios.length === 0) continue;
    ratios.sort((p, q) => p - q);
    results.push({ text: b.text, disabled: b.disabled, p2: ratios[Math.floor(ratios.length * 0.02)]!, min: ratios[0]!, px: b.px });
  }
  return results;
}
