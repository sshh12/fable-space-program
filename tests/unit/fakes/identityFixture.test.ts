/**
 * The identity fixture (src/core/fakes/identityFixture.ts): the seam the menu's identity screen calls - a check
 * that answers available, taken (with suggestions) or invalid (with the service's words), a create that fixes
 * the callsign and returns a 100-bit recovery code once, answers held until `advance` moves the fixture's time.
 */
import { describe, expect, it } from 'vitest';
import { createIdentityFixture } from '@/core/fakes/identityFixture';

describe('the identity fixture', () => {
  it('checks a callsign against the service rule and the taken ones', async () => {
    const id = createIdentityFixture({ taken: ['KESTREL-41'] });
    expect(id.callsign()).toBeNull();
    expect(await id.check('kestrel-41')).toEqual({ status: 'taken', suggestions: ['KESTREL-41-2', 'KESTREL-41-3', 'KESTREL-41-4'] });
    expect(await id.check('ab')).toEqual({ status: 'invalid', reason: id.rule() });
    expect(await id.check('PLOVER-7')).toEqual({ status: 'available' });
  });

  it('creates the account once: the callsign is set and the recovery code has 20 symbols of 5 bits', async () => {
    const id = createIdentityFixture();
    const { recoveryCode } = await id.create('plover-7');
    expect(id.callsign()).toBe('PLOVER-7');
    expect(recoveryCode).toMatch(/^([2-9A-HJ-NP-Z]{4}-){4}[2-9A-HJ-NP-Z]{4}$/);
    expect(await id.check('PLOVER-7')).toMatchObject({ status: 'taken' });
    await expect(id.create('x')).rejects.toThrow(/must be/);
  });

  it('holds its answers until its time is advanced, and generates callsigns that are free', async () => {
    const id = createIdentityFixture({ answerSeconds: 0.3, taken: [] });
    let answer: string | null = null;
    void id.check('TERN-12').then((r) => (answer = r.status));
    id.advance(0.2);
    await Promise.resolve();
    expect(answer).toBeNull();
    id.advance(0.2);
    await Promise.resolve();
    expect(answer).toBe('available');
    const g = id.generate();
    const checked = id.check(g);
    id.advance(1);
    expect(await checked).toEqual({ status: 'available' });
  });
});
