Status: resolved (commit edfd096)
From: atmosphere-clouds
Owner path: src/core/contracts/defs.ts (`AtmosphereRenderDef`)
Blocking: no        (the renderer reads and validates the field already; this makes it part of the contract)

## Problem
Request `sky-lighting-9` asked this package for airglow (the night limb's green band and the faint red layer
above it). It is drawn now, as per-body data in the body's atmosphere definition, but
`AtmosphereRenderDef` does not declare the field, so `src/render/atmosphere/airglow.ts` reads it through a
cast (`def as AtmosphereRenderDef & { airglow?: unknown }`) and validates it itself.

## Evidence
- `data/defs/render/earth.atmosphere.json`: key `airglow` (two layers).
- `src/render/atmosphere/airglow.ts`: `resolveAirglow(def)`, the cast, and the validation (malformed layers
  are reported with `reportError` and left out).
- The loader passes the key through (no schema for render sections), so nothing breaks today; a typed
  consumer elsewhere (the sky package's probe, the map view) cannot see the field without the same cast.

## Requested change
In `src/core/contracts/defs.ts`:

```ts
/** One optically thin emitting layer of the upper atmosphere (airglow). */
export interface AirglowLayerDef {
  /** Altitude of the emission peak above the reference radius, m. */
  altitude: number;
  /** Full width at half maximum of the (Gaussian) emission profile, m. */
  thickness: number;
  /** Luminance seen straight up from under the layer, cd/m^2. */
  zenithLuminance: number;
  /** Linear sRGB, any scale (the renderer normalises it to unit luminance). */
  color: Vec3Tuple;
}

export interface AtmosphereRenderDef {
  ...
  /** Airglow layers (absent = none). */
  airglow?: AirglowLayerDef[];
}
```

Must not change: anything else in `AtmosphereRenderDef`; the field is optional, so bodies without it (and
every existing fake or test definition) stay valid. When it is in, I replace the cast in
`src/render/atmosphere/airglow.ts` by the declared type (the validation stays: data files are not checked
against the types at run time).

## Resolution

Done as requested (`edfd096`): `AirglowLayerDef` (altitude, thickness, zenithLuminance, color; your doc comments)
and `AtmosphereRenderDef.airglow?: AirglowLayerDef[]` in `src/core/contracts/defs.ts`. Optional, nothing else in the
interface changed; `npm run typecheck` shows no new error. Replace the cast in `src/render/atmosphere/airglow.ts`.
