/**
 * The identity screen (frontend-ux 5.4; ARCHITECTURE 25, decision 47): on the first Play, before the lobby, the
 * player picks a callsign in one field (checked by the account service 300 ms after the last key; GENERATE asks
 * the service for one) and then sees the recovery code ONCE, with copy and download. Everything about what a
 * callsign may be is the service's (`IdentityHost.check` and its words); the screen only shows the answer.
 *
 * The flow's state lives across rebuilds in an `IdentityFlow` the shell keeps: choose -> creating -> shown.
 */
import { el, focusable } from './dom/kit';
import type { ScreenCtx, ScreenView } from './screens';
import type { CallsignCheck, IdentityHost } from './types';

/** Seconds of no typing before the callsign is checked. */
const CHECK_AFTER_S = 0.3;

export interface IdentityFlow {
  phase: 'choose' | 'creating' | 'shown';
  name: string;
  /** The service's answer for `checkedName`; null while none (or checking). */
  check: CallsignCheck | null;
  checkedName: string;
  checking: boolean;
  /** When the name last changed (performance.now ms); the check waits CHECK_AFTER_S after it. */
  typedAt: number;
  recoveryCode: string | null;
  error: string | null;
}

export const newIdentityFlow = (): IdentityFlow => ({ phase: 'choose', name: '', check: null, checkedName: '', checking: false, typedAt: 0, recoveryCode: null, error: null });

/** True when Play must pass through the identity screen first (a page with the seam and no callsign yet). */
export const needsIdentity = (host: IdentityHost | null): boolean => host !== null && host.callsign() === null;

export function identityScreen(ctx: ScreenCtx, host: IdentityHost, flow: IdentityFlow, done: () => void): ScreenView {
  return flow.phase === 'shown' && flow.recoveryCode !== null ? recoveryView(host, flow, done) : chooseView(ctx, host, flow);
}

function chooseView(ctx: ScreenCtx, host: IdentityHost, flow: IdentityFlow): ScreenView {
  const main = el('div', '');
  main.append(el('div', 'sh-titles', el('h1', 'sh-title', 'Choose a callsign'), el('p', 'sh-subtitle', 'No sign-up, no email. This browser holds a key that is your identity.')));
  const p = el('div', 'sh-panel');
  p.dataset['scrim'] = '0.7';
  p.dataset['testid'] = 'identity';
  const field = el('input', 'sh-field sh-callsign');
  field.value = flow.name;
  field.maxLength = 32;
  field.spellcheck = false;
  field.autocomplete = 'off';
  field.dataset['focus'] = 'callsign';
  field.setAttribute('aria-label', 'Callsign');
  const verdict = el('div', 'sh-verdict');
  verdict.dataset['testid'] = 'callsign-verdict';
  field.addEventListener('input', () => {
    flow.name = field.value;
    flow.typedAt = performance.now();
    flow.check = null;
    flow.error = null;
    paint();
  });
  const generate = focusable(el('button', 'sh-prompt'), 'callsign-generate', () => {
    flow.name = host.generate();
    flow.typedAt = performance.now() - CHECK_AFTER_S * 1000;
    flow.check = null;
    ctx.rebuild();
  });
  generate.append('Generate');
  const confirm = focusable(el('button', 'sh-card'), 'callsign-confirm', () => {
    if (!(flow.check?.status === 'available' && flow.checkedName === flow.name.trim()) || flow.phase !== 'choose') return;
    flow.phase = 'creating';
    flow.error = null;
    ctx.rebuild();
    host.create(flow.name.trim()).then(
      (r) => {
        flow.recoveryCode = r.recoveryCode;
        flow.phase = 'shown';
        ctx.rebuild();
      },
      (e: unknown) => {
        flow.phase = 'choose';
        flow.error = e instanceof Error ? e.message : String(e);
        ctx.rebuild();
      },
    );
  });
  confirm.dataset['scrim'] = '0.7';
  const confirmTitle = el('span', 'sh-card-title', 'Confirm');
  const confirmText = el('span', 'sh-card-text', '');
  confirm.append(confirmTitle, confirmText);
  const paint = (): void => {
    const name = flow.name.trim();
    const c = flow.checkedName === name ? flow.check : null;
    verdict.replaceChildren();
    verdict.className = 'sh-verdict';
    if (flow.error) {
      verdict.classList.add('sh-alert');
      verdict.append(flow.error);
    } else if (!name) verdict.append('');
    else if (flow.checking || !c) verdict.append('Checking…');
    else if (c.status === 'available') {
      verdict.classList.add('sh-ok');
      verdict.append(`✓ ${name.toUpperCase()} is available`);
    } else if (c.status === 'taken') {
      verdict.classList.add('sh-warn');
      verdict.append(`${name.toUpperCase()} is taken`);
      for (const s of c.suggestions) {
        const b = focusable(el('button', 'sh-chip'), `callsign-suggest-${s}`, () => {
          flow.name = s;
          flow.typedAt = performance.now() - CHECK_AFTER_S * 1000;
          ctx.rebuild();
        });
        b.textContent = s;
        verdict.append(b);
      }
    } else {
      verdict.classList.add('sh-warn');
      verdict.append(`A callsign is ${c.reason}.`);
    }
    const ok = c?.status === 'available' && flow.phase === 'choose';
    confirm.setAttribute('aria-disabled', String(!ok));
    confirmTitle.textContent = flow.phase === 'creating' ? 'Creating…' : 'Confirm';
    confirmText.textContent = ok ? `Fly as ${name.toUpperCase()}` : 'Pick a callsign that is free';
  };
  const live = (): void => {
    const name = flow.name.trim();
    if (flow.phase !== 'choose' || !name || flow.checking || flow.checkedName === name) return;
    if (performance.now() - flow.typedAt < CHECK_AFTER_S * 1000) return;
    flow.checking = true;
    paint();
    host.check(name).then(
      (r) => {
        flow.checking = false;
        flow.checkedName = name;
        flow.check = r;
        paint();
      },
      (e: unknown) => {
        flow.checking = false;
        flow.error = e instanceof Error ? e.message : String(e);
        paint();
      },
    );
  };
  p.append(el('div', 'sh-label', 'Callsign'), el('div', 'sh-callsign-row', field, generate), verdict, el('p', 'sh-body sh-dim', `${host.rule()}. Shown above your craft to everyone.`));
  main.append(p, confirm);
  paint();
  return {
    main,
    prompts: [{ action: 'menu:activate', text: 'Confirm' }, { action: 'menu:secondary', text: 'Generate' }, { action: 'menu:back', text: 'Back' }],
    actions: {
      // Enter in the field confirms when the name is free (the shell's text-field rule sends menu:activate to the screen's focus).
      'menu:activate': () => {
        confirm.click();
        return true;
      },
      'menu:secondary': () => {
        generate.click();
        return true;
      },
    },
    focus: 'callsign',
    subject: 'earth',
    live,
  };
}

function recoveryView(host: IdentityHost, flow: IdentityFlow, done: () => void): ScreenView {
  const code = flow.recoveryCode!;
  const callsign = host.callsign() ?? flow.name.trim().toUpperCase();
  const main = el('div', '');
  main.append(el('div', 'sh-titles', el('h1', 'sh-title', 'Save your recovery code'), el('p', 'sh-subtitle', `Welcome, ${callsign}.`)));
  const p = el('div', 'sh-panel sh-strong');
  p.dataset['scrim'] = '0.75';
  p.dataset['testid'] = 'recovery-code';
  const copied = el('span', 'sh-dim', '');
  const copy = focusable(el('button', 'sh-prompt'), 'recovery-copy', () => {
    void navigator.clipboard?.writeText(code).then(
      () => (copied.textContent = 'Copied'),
      () => (copied.textContent = 'The browser refused the clipboard: write the code down'),
    );
  });
  copy.append('Copy');
  const download = focusable(el('button', 'sh-prompt'), 'recovery-download', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`Fable Space Program recovery code for ${callsign}\n${code}\n`], { type: 'text/plain' }));
    a.download = `fable-space-program-${callsign.toLowerCase()}-recovery.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  download.append('Download .txt');
  p.append(
    el('div', 'sh-code', code),
    el('div', 'sh-callsign-row', copy, download, copied),
    el('p', 'sh-body', `Lose this browser's data and this code is the only way back to ${callsign} and your ships. We cannot recover it for you. It is shown once.`),
  );
  const saved = focusable(el('button', 'sh-card'), 'recovery-saved', done);
  saved.dataset['scrim'] = '0.7';
  saved.append(el('span', 'sh-card-title', 'I have saved it'), el('span', 'sh-card-text', 'On to the lobby'));
  main.append(p, saved);
  return { main, prompts: [{ action: 'menu:activate', text: 'Continue' }], actions: { 'menu:back': () => true }, focus: 'recovery-saved', subject: 'earth' };
}
