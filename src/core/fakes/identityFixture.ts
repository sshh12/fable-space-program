/**
 * The identity seam as a fixture (ARCHITECTURE 25, decision 47; frontend-ux 5.4 and 6): an anonymous account
 * behind a device key, a callsign, a recovery code shown once. No network: the fixture stands in for the
 * account service the menu's identity screen calls (`IdentityHost` of src/shell, structurally), so the screen is
 * built and tested before the service exists (universe-directory and netcode-client fill the same seam).
 *
 * What it states. The callsign of the account (null until one is created), the callsigns already taken, the
 * service's rule for a callsign (`pattern` with the words that explain it: the service's, not the menu's), a
 * deterministic recovery code per account, and a delay before each answer (`answerSeconds`, moved only by
 * `advance`, as the menu store fixture moves its time).
 */

export type CallsignCheck = { status: 'available' } | { status: 'taken'; suggestions: string[] } | { status: 'invalid'; reason: string };

export interface IdentityFixtureOptions {
  /** The account's callsign when it already has one; null = first Play (the identity screen comes first). */
  callsign?: string | null;
  /** Callsigns other accounts hold (compared without case). */
  taken?: readonly string[];
  /** The service's callsign rule and its words. */
  pattern?: RegExp;
  patternWords?: string;
  /** Seconds before a check or a create answers (time moves through `advance`). */
  answerSeconds?: number;
  /** Seed of the generated callsigns and of the recovery code. */
  seed?: number;
}

export interface IdentityFixture {
  callsign(): string | null;
  check(name: string): Promise<CallsignCheck>;
  create(name: string): Promise<{ recoveryCode: string }>;
  /** A callsign the service proposes (GENERATE). */
  generate(): string;
  /** The rule's words, for the field's caption. */
  rule(): string;
  advance(dt: number): void;
}

const WORDS = ['KESTREL', 'PLOVER', 'EGRET', 'TERN', 'PETREL', 'AVOCET', 'MERLIN', 'SWIFT', 'HERON', 'CORMORANT'];
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function createIdentityFixture(opts: IdentityFixtureOptions = {}): IdentityFixture {
  let callsign = opts.callsign ?? null;
  const taken = new Set((opts.taken ?? []).map((t) => t.toUpperCase()));
  const pattern = opts.pattern ?? /^[A-Za-z0-9-]{3,14}$/;
  const words = opts.patternWords ?? '3 to 14 letters, digits or hyphens';
  const delay = opts.answerSeconds ?? 0;
  let seed = (opts.seed ?? 41) >>> 0;
  const next = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  let clock = 0;
  const pending: { at: number; run: () => void }[] = [];
  const later = <T>(f: () => T): Promise<T> =>
    new Promise((resolve, reject) => {
      const run = (): void => {
        try {
          resolve(f());
        } catch (e) {
          reject(e);
        }
      };
      if (delay <= 0) run();
      else pending.push({ at: clock + delay, run });
    });
  const verdict = (name: string): CallsignCheck => {
    const n = name.trim();
    if (!pattern.test(n)) return { status: 'invalid', reason: words };
    if (taken.has(n.toUpperCase())) {
      const suggestions: string[] = [];
      for (let i = 2; suggestions.length < 3 && i < 100; i++) {
        const s = `${n.toUpperCase().slice(0, 11)}-${i}`;
        if (!taken.has(s) && pattern.test(s)) suggestions.push(s);
      }
      return { status: 'taken', suggestions };
    }
    return { status: 'available' };
  };
  return {
    callsign: () => callsign,
    check: (name) => later(() => verdict(name)),
    create: (name) =>
      later(() => {
        const v = verdict(name);
        if (v.status !== 'available') throw new Error(v.status === 'taken' ? `The callsign ${name} is taken.` : `The callsign must be ${words}.`);
        callsign = name.trim().toUpperCase();
        taken.add(callsign);
        const groups: string[] = [];
        for (let g = 0; g < 5; g++) {
          let s = '';
          for (let i = 0; i < 4; i++) s += CODE_ALPHABET[next() % CODE_ALPHABET.length];
          groups.push(s);
        }
        return { recoveryCode: groups.join('-') };
      }),
    generate: () => {
      for (;;) {
        const s = `${WORDS[next() % WORDS.length]}-${10 + (next() % 90)}`;
        if (!taken.has(s)) return s;
      }
    },
    rule: () => words,
    advance(dt) {
      clock += dt;
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i]!.at <= clock) {
          const p = pending.splice(i, 1)[0]!;
          p.run();
        }
      }
    },
  };
}
