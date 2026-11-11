/**
 * Order-sensitive hash of plain data for Sim.stateHash(): numbers by their float64 bits, strings by code
 * unit, booleans as 0/1, null/undefined as one marker, arrays in order, objects by sorted key.
 */
import { hashU32 } from '@/core/math/hash';

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

export class StateHasher {
  private a = 0x811c9dc5;
  private b = 0x9e3779b9;

  num(x: number): void {
    f64[0] = x;
    this.a = hashU32((this.a ^ u32[0]!) >>> 0);
    this.a = hashU32((this.a ^ u32[1]!) >>> 0);
    this.b = hashU32((Math.imul(this.b, 31) + u32[0]!) >>> 0);
    this.b = hashU32((Math.imul(this.b, 31) + u32[1]!) >>> 0);
  }

  str(s: string): void {
    this.num(s.length);
    for (let i = 0; i < s.length; i++) this.num(s.charCodeAt(i));
  }

  any(x: unknown): void {
    if (typeof x === 'number') this.num(x);
    else if (typeof x === 'boolean') this.num(x ? 1 : 0);
    else if (typeof x === 'string') this.str(x);
    else if (x === null || x === undefined) this.num(-1);
    else if (Array.isArray(x)) {
      this.num(x.length);
      for (const e of x) this.any(e);
    } else if (typeof x === 'object') {
      for (const k of Object.keys(x as object).sort()) {
        this.str(k);
        this.any((x as Record<string, unknown>)[k]);
      }
    }
  }

  hex(): string {
    return (this.a >>> 0).toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0');
  }
}
