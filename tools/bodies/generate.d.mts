// Types of generate.mjs for the TypeScript tests (tests/unit/bodies).
export const STAGED_BODIES: string;
export const STAGED_TERRAIN: string;
export const FIXTURE: string;
export const PROVENANCE: string;
/** Every generated file: repository-relative path -> exact content. */
export function generateFiles(): Map<string, string>;
