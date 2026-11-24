/**
 * The fingerprints and vehicle hashes of codec versions 1 to 3, against today's kind: RECORDED ONCE, at the
 * version step of the tighten after sub-wave 3.2 (2026-11-24), from the library as it stood (the tree of
 * commit 0ed52e1: 25 part definitions, 1 vehicle).
 *
 * Versions 1 to 3 named a part definition by a fingerprint over its WHOLE module definitions and a vehicle
 * by the hash of its WHOLE definition, presentation fields included. From version 4 both are taken of the
 * simulation projection (src/core/defs/simProjection.ts). A blob of version 1 to 3 carries a value of the
 * old kind, which cannot be recomputed once a presentation field of the definition has changed (that field
 * is free from this step on). This table is how such a blob is still read: the value of the old kind that
 * every blob written before the step carries, and the value of the new kind the same definition had at
 * the step; for a part under its definition id, for a vehicle under the old hash alone (the simulation's
 * source names no vehicle of the library: tests/unit/sim-world/milestones.test.ts). The decoder reads the old value as the new one; from there the migration
 * registry applies as for any blob.
 *
 * NEVER EDITED: it states what was. A part or a vehicle defined after the step has no entry and needs
 * none (no blob of version 1 to 3 was written under it). tools/dev/guard-pins.test.ts holds this file.
 * Where the two values are equal the definition has no presentation field in what was hashed.
 */
export const LEGACY_PART_FINGERPRINTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'atlas-9m': { 'bf93332acaa950f1': '8ec12a06a6081665' },
  'heron-ascent-stage': { '4debb77779aa6531': '4debb77779aa6531' },
  'heron-capsule-adapter': { 'ceeb8bba16ec0bf3': 'ceeb8bba16ec0bf3' },
  'heron-descent-stage': { '03e7a52f469b5717': '03e7a52f469b5717' },
  'heron-landing-legs': { '6f670c07d78d27ad': '6f670c07d78d27ad' },
  'heron-stage-separator': { '80e0a644f59f74a7': '80e0a644f59f74a7' },
  'kestrel-apex-cover': { 'c4d192eb83ca639e': 'c4d192eb83ca639e' },
  'kestrel-capsule': { 'e6f5a19f6b48843c': '202734369dbd8672' },
  'kestrel-les': { '77173d4ad1ed9844': '61268fd9279ef91e' },
  'kestrel-les-jettison-motor': { 'a27039977308e0a1': '1ab07fda2fbe862a' },
  'lyra-a': { '2178403bde52ceda': 'd3ff85015ff6af9f' },
  'lyra-d': { '1e9f5bca623a92e6': '718f131ba8e85810' },
  'meridian-interstage-1': { '49bb353170df9093': '49bb353170df9093' },
  'meridian-interstage-2': { '24b6d3988d4a24bf': '24b6d3988d4a24bf' },
  'meridian-lander-fairing': { 'f2653f1bc486d440': 'f2653f1bc486d440' },
  'meridian-launch-clamp': { 'cce1626d4e9f843e': 'cce1626d4e9f843e' },
  'meridian-m1': { '98f407ad256762c1': '98f407ad256762c1' },
  'meridian-m1-retro-motors': { 'ca54471963ff53b1': 'd8f4dfb969768000' },
  'meridian-m2': { '4ba93f217b353291': '4ba93f217b353291' },
  'meridian-m2-ullage-motors': { '4e89e0646b39fcbc': '264b270576d5f6eb' },
  'meridian-m3': { '64f9735ff44825dc': '64f9735ff44825dc' },
  'meridian-m3-rcs-pod': { '3077b29131a4fb6d': 'b3f0af4d5fad3e4c' },
  'meridian-payload-adapter': { 'c642836b5fd9c288': 'c642836b5fd9c288' },
  'vela-2': { '1d9a360fbd75d7ff': 'eadb4f3836e33a0c' },
  'vela-2v': { '1400987975c21749': '93086a1bc2865051' },
};

export const LEGACY_VEHICLE_HASHES: Readonly<Record<string, string>> = {
  d967aabfd87b2f5b: '337fcbff36efa08a',
};
