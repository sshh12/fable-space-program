/**
 * The block page (frontend-ux 9.7) and the pass banners. One static template, copy by reason: what happened,
 * what to do, a copy-report control (the CapabilityReport as JSON, for bug reports), the live player count
 * from the public status document (ARCHITECTURE 27: `GET /status.json`, `online`), and Credits rendered from
 * the credits section when it is served. No WebGPU, no image, nothing of the main bundle.
 */
import type { GateReason, GateReport } from './report';

interface Copy {
  headline: string;
  body: string;
  steps: string[];
}

const LAPTOP_STEP = 'On a laptop with two graphics chips: Windows Settings > System > Display > Graphics, choose Chrome or Edge, set it to "High performance", then restart the browser.';

/** Headline, explanation and what to do, per reason. */
export function copyFor(reason: GateReason, report: GateReport): Copy {
  switch (reason) {
    case 'mobile':
      return {
        headline: 'This needs a desktop computer',
        body: 'The universe runs a true-scale solar system and live multiplayer on your graphics card through WebGPU. It is built for desktop Chrome or Edge with a dedicated graphics card. Phones and tablets are not supported.',
        steps: ['Copy the link or e-mail it to yourself, and open it on a desktop computer.'],
      };
    case 'noWebGpu':
      return {
        headline: 'Your browser has no WebGPU',
        body: `${report.browser === 'unknown' ? 'This browser' : report.browser} does not offer WebGPU to this page.`,
        steps: report.untestedBrowser
          ? ['Use an up-to-date desktop Chrome or Edge.']
          : ['Update Chrome or Edge to the latest version.', 'If it is already current: update your graphics driver, then open chrome://gpu and check that WebGPU is "Hardware accelerated".'],
      };
    case 'noAdapter':
    case 'fallbackAdapter':
      return {
        headline: 'Your browser is not using a graphics card',
        body: reason === 'noAdapter' ? 'The browser gave this page no graphics adapter.' : 'The browser offers only a software renderer, which cannot run the game.',
        steps: ['Update your graphics driver.', LAPTOP_STEP, 'Check chrome://gpu: WebGPU should read "Hardware accelerated".'],
      };
    case 'missingFeature':
    case 'lowLimits':
      return {
        headline: 'Your graphics card is missing something this needs',
        body: report.reasonText || '',
        steps: ['Update your graphics driver and the browser; if that does not help, this graphics card cannot run the game.', LAPTOP_STEP],
      };
    case 'deviceFailed':
      return {
        headline: 'The graphics device could not be started',
        body: report.reasonText || '',
        steps: ['Close other programs that use the graphics card and reload.', 'Update your graphics driver.', LAPTOP_STEP],
      };
    case 'missingApi':
      return {
        headline: 'Your browser is missing something this needs',
        body: report.reasonText || '',
        steps: ['Use an up-to-date desktop Chrome or Edge, outside a private window.'],
      };
  }
}

const CSS = `
#fsp-gate{position:fixed;inset:0;z-index:1000;overflow:auto;background:radial-gradient(120% 90% at 50% 30%,#0c1522 0%,#070b12 55%,#04060a 100%);color:#eef4fb;font:15px/1.5 Bahnschrift,'DIN Alternate','Segoe UI',system-ui,sans-serif}
#fsp-gate .w{max-width:46rem;margin:0 auto;padding:12vh 6vw 4rem}
#fsp-gate .k{letter-spacing:.24em;color:#55d4ff;font-size:.8rem}
#fsp-gate h1{font-size:1.9rem;font-weight:600;margin:.6rem 0 .8rem;text-transform:uppercase;letter-spacing:.04em}
#fsp-gate p,#fsp-gate li{color:#b9c4d4}
#fsp-gate ol{padding-left:1.2rem}
#fsp-gate button,#fsp-gate a.b{display:inline-block;margin:.4rem .6rem .4rem 0;padding:.45rem 1rem;border:1px solid #55d4ff;background:transparent;color:#eef4fb;font:inherit;letter-spacing:.08em;text-transform:uppercase;text-decoration:none;cursor:pointer}
#fsp-gate button:focus-visible,#fsp-gate a.b:focus-visible{outline:2px solid #fff;outline-offset:2px}
#fsp-gate pre{white-space:pre-wrap;word-break:break-all;background:#0a111b;border:1px solid #1d2a3a;padding:.8rem;color:#9fb0c6;font-size:.8rem}
#fsp-gate .live{margin-top:1.4rem;color:#8fe3a8}
#fsp-gate .f{margin-top:2.4rem;font-size:.85rem;color:#7d8aa0}
#fsp-banner{position:fixed;top:0;left:0;right:0;z-index:1000;display:flex;gap:1rem;align-items:center;justify-content:center;padding:.4rem 1rem;background:#1a2433;color:#eef4fb;font:13px/1.4 'Segoe UI',system-ui,sans-serif}
#fsp-banner button{background:transparent;border:1px solid #55d4ff;color:#eef4fb;font:inherit;cursor:pointer}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function addStyle(): void {
  if (document.getElementById('fsp-gate-style')) return;
  const s = el('style', CSS);
  s.id = 'fsp-gate-style';
  document.head.appendChild(s);
}

async function copyText(text: string, button: HTMLButtonElement, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = el('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  button.textContent = done;
}

/** "live: 1,284 players online" from the public status document; nothing when it does not answer. */
async function showPlayerCount(url: string, line: HTMLElement): Promise<void> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return;
    const doc = (await res.json()) as { online?: unknown };
    if (typeof doc.online !== 'number' || !Number.isFinite(doc.online)) return;
    line.textContent = `live: ${Math.round(doc.online).toLocaleString('en-US')} players online`;
    line.hidden = false;
  } catch {
    line.hidden = true;
  }
}

/** Every string of the credits document, as lines (its layout is the menu's; the block page lists what it holds). */
function creditLines(doc: unknown, out: string[]): void {
  if (typeof doc === 'string') out.push(doc);
  else if (Array.isArray(doc)) for (const x of doc) creditLines(x, out);
  else if (doc && typeof doc === 'object') {
    const parts: string[] = [];
    const nested: unknown[] = [];
    for (const v of Object.values(doc as Record<string, unknown>)) {
      if (typeof v === 'string') parts.push(v);
      else nested.push(v);
    }
    if (parts.length > 0) out.push(parts.join(' - '));
    for (const n of nested) creditLines(n, out);
  }
}

async function showCredits(url: string, box: HTMLElement): Promise<void> {
  box.textContent = '';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const lines: string[] = [];
    creditLines(await res.json(), lines);
    const list = el('ul');
    for (const l of lines) list.appendChild(el('li', l));
    box.appendChild(list);
  } catch {
    box.appendChild(el('p', 'The credits could not be loaded.'));
  }
}

export interface BlockPageUrls {
  status: string;
  credits: string;
}

/** Replace the boot screen with the block page of the report's reason. */
export function showBlockPage(report: GateReport, urls: BlockPageUrls): HTMLElement {
  addStyle();
  const reason = report.reason!;
  const copy = copyFor(reason, report);
  const root = el('div');
  root.id = 'fsp-gate';
  root.setAttribute('role', 'alert');
  root.dataset['reason'] = reason;
  const w = el('div', undefined, 'w');
  root.appendChild(w);
  w.appendChild(el('div', 'FABLE SPACE PROGRAM', 'k'));
  w.appendChild(el('h1', copy.headline));
  if (copy.body) w.appendChild(el('p', copy.body));
  const steps = el('ol');
  for (const s of copy.steps) steps.appendChild(el('li', s));
  w.appendChild(steps);

  const actions = el('div');
  if (reason === 'mobile') {
    const link = location.href;
    const copyLink = el('button', 'Copy link');
    copyLink.onclick = () => void copyText(link, copyLink, 'Link copied');
    actions.appendChild(copyLink);
    const mail = el('a', 'E-mail me the link', 'b');
    mail.href = `mailto:?subject=${encodeURIComponent('Fable Space Program')}&body=${encodeURIComponent(link)}`;
    actions.appendChild(mail);
  }
  const reportJson = JSON.stringify(report, null, 2);
  const copyReport = el('button', 'Copy report');
  copyReport.dataset['action'] = 'copy-report';
  copyReport.onclick = () => void copyText(reportJson, copyReport, 'Report copied');
  actions.appendChild(copyReport);
  w.appendChild(actions);

  const live = el('div', '', 'live');
  live.hidden = true;
  live.dataset['role'] = 'players';
  w.appendChild(live);
  void showPlayerCount(urls.status, live);

  const details = el('details');
  details.appendChild(el('summary', 'Technical details'));
  details.appendChild(el('pre', reportJson));
  w.appendChild(details);

  const foot = el('div', undefined, 'f');
  const credits = el('button', 'Credits');
  const creditBox = el('div');
  credits.onclick = () => void showCredits(urls.credits, creditBox);
  foot.appendChild(credits);
  foot.appendChild(creditBox);
  w.appendChild(foot);

  const splash = document.getElementById('boot-splash');
  if (splash) splash.remove();
  document.body.appendChild(root);
  document.title = `Fable Space Program - ${copy.headline}`;
  return root;
}

/** The non-blocking findings over the game (a small window, no audio, an untested browser), dismissible. */
export function showBanner(warnings: readonly string[]): HTMLElement | null {
  if (warnings.length === 0) return null;
  addStyle();
  const bar = el('div');
  bar.id = 'fsp-banner';
  bar.setAttribute('role', 'status');
  bar.appendChild(el('span', warnings.join(' ')));
  const close = el('button', 'Dismiss');
  close.onclick = () => bar.remove();
  bar.appendChild(close);
  document.body.appendChild(bar);
  return bar;
}
