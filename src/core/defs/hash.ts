/**
 * The hash of a definition library: `defsHash` of the session handshake and of every vessel blob's header
 * (docs/ARCHITECTURE.md 7.2, 12). A client whose library hashes otherwise than the server's is refused before
 * anything else, so the hash covers everything the library holds: bodies, sites, resources, parts,
 * assemblies, the flattened vehicles, the rules documents, scenarios and the sections. It is taken of the
 * LOADED library (refs resolved, files completed, vehicles flattened), so two sources that load to the same
 * library hash the same, whatever their file layout.
 *
 * Canonical JSON (object keys sorted, `undefined` members left out, numbers as JSON writes them) hashed to
 * 64 bits in two independent 32-bit lanes. Pure and platform-neutral (src/core imports nothing outside
 * src/core): the definition-bundle plugin of the build and Node tools call it alike.
 */
import type { DefLibrary } from '../contracts/defs';
import { hashU32 } from '../math/hash';

/** JSON with the keys of every object sorted: equal content gives equal text. */
export function canonicalText(x: unknown): string {
  if (x === null || typeof x !== 'object') {
    if (typeof x === 'number' && !Number.isFinite(x)) throw new Error(`canonicalText: ${x} has no JSON form (a library holds finite numbers only)`);
    return JSON.stringify(x) ?? 'null';
  }
  if (Array.isArray(x)) return `[${x.map(canonicalText).join(',')}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalText(o[k])}`)
    .join(',')}}`;
}

/** 64-bit hash of a text's UTF-16 code units, as 16 hex digits. */
export function hashText(text: string): string {
  let a = hashU32((0x811c9dc5 ^ text.length) >>> 0);
  let b = 0x9e3779b9;
  for (let i = 0; i < text.length; i += 2) {
    const w = (text.charCodeAt(i) | ((i + 1 < text.length ? text.charCodeAt(i + 1) : 0) << 16)) >>> 0;
    a = hashU32((a ^ w) >>> 0);
    b = hashU32((Math.imul(b, 31) + w) >>> 0);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** The hash of a loaded definition library (`defsHash`). */
export function hashLibrary(defs: DefLibrary): string {
  return hashText(
    canonicalText({
      bodies: defs.bodies,
      rootBodyId: defs.rootBodyId,
      sites: defs.sites,
      resources: defs.resources,
      parts: defs.parts,
      assemblies: defs.assemblies ?? {},
      vehicles: defs.vehicles,
      rules: defs.rules ?? {},
      scenarios: defs.scenarios,
      sections: defs.sections,
    }),
  );
}
