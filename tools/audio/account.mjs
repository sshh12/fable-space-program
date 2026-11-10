#!/usr/bin/env node
/**
 * Prints the ElevenLabs subscription tier and credit usage (no key material) so a generation run can be
 * budgeted before it starts:   node tools/audio/account.mjs
 */
import { readEnvKey } from './env.mjs';

const key = readEnvKey('ELEVENLABS_API_KEY');
const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': key } });
if (!res.ok) {
  console.error(`subscription query failed: HTTP ${res.status}`);
  process.exit(1);
}
const s = await res.json();
console.log(
  JSON.stringify(
    {
      tier: s.tier,
      status: s.status,
      creditsUsed: s.character_count,
      creditLimit: s.character_limit,
      creditsLeft: s.character_limit - s.character_count,
      nextReset: s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000).toISOString() : null,
    },
    null,
    2,
  ),
);
