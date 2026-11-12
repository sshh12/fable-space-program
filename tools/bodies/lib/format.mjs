// JSON formatting of the generated files: two-space indentation, arrays of numbers (vectors, tables rows) on
// one line, a trailing newline. Deterministic, so `generate.mjs --check` can compare bytes.

export function formatJson(value) {
  return `${fmt(value, '')}\n`;
}

function fmt(v, indent) {
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (v.every((x) => typeof x === 'number' || typeof x === 'string' || x === null)) return `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
    if (v.every((x) => Array.isArray(x) && x.every((y) => typeof y === 'number'))) {
      const inner = indent + '  ';
      return `[\n${v.map((x) => inner + fmt(x, inner)).join(',\n')}\n${indent}]`;
    }
    const inner = indent + '  ';
    return `[\n${v.map((x) => inner + fmt(x, inner)).join(',\n')}\n${indent}]`;
  }
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 0) return '{}';
    const inner = indent + '  ';
    return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${fmt(v[k], inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(v);
}
