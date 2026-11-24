/**
 * The number rule of the game, as the shell receives it. The HUD's formatters (src/ui/format.ts) are the one
 * number rule (frontend-ux 4.3), and src/shell may not import src/ui (tools/dev/boundaries.test.ts): the app
 * hands them in (`ShellDeps.format`), and the shell's models take them as an argument. Request shell-menu-3
 * asks for the formatters in src/core/ui, after which this is an import.
 */
export interface NumberFormat {
  /** Fixed-point number with grouped thousands ("1,284"), as `formatNumber`. */
  number(x: number, decimals?: number): string;
  /** Apoapsis / periapsis altitude ("412.0 km"), as `formatApsis`. */
  apsis(m: number): string;
  /** Clock-style duration ("6:12", "1:02:03"), as `formatDuration`. */
  duration(seconds: number): string;
  /** Delta-v ("4,210 m/s"), as `formatDeltaV`. */
  deltaV(mps: number): string;
  /** Mass ("2,760 t"), as `formatMass`. */
  mass(kg: number): string;
}
