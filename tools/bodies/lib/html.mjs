// Minimal, dependency-free readers for the HTML documents of tools/bodies/lib/sourceList.mjs. They only ever
// read text out of the markup; nothing in a download is evaluated.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', plusmn: '±', pm: '±', times: '×', deg: '°', mdash: '-', ndash: '-', minus: '-', sup2: '2', sup3: '3', dagger: '†', lambda: 'λ', rho: 'ρ', straightphi: 'φ' };

export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z0-9]+);/gi, (m, n) => (n.toLowerCase() in ENTITIES ? ENTITIES[n.toLowerCase()] : m));
}

/** Text content of an HTML fragment: tags removed, entities decoded, whitespace collapsed. */
export function textOf(html) {
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/** Every table row of the document as an array of cell texts (td and th). */
export function tableRows(html) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const cells = [];
    const tdRe = /<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/gi;
    let c;
    while ((c = tdRe.exec(m[1])) !== null) cells.push(textOf(c[2]));
    rows.push(cells);
  }
  return rows;
}

/** Lines of the document's text (tags replaced by line breaks), trimmed, empty lines dropped. */
export function textLines(html) {
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d|pre|td|th)>/gi, '\n').replace(/<[^>]*>/g, ''))
    .split('\n')
    .map((l) => l.replace(/[\s ]+/g, ' ').trim())
    .filter((l) => l.length > 0);
}

/** Parse a number as printed in the sources ("1,345.5", "384400.", "-0.60", "1.2D-3"); NaN when it is not one. */
export function num(s) {
  if (typeof s !== 'string') return NaN;
  const t = s.replace(/,/g, '').replace(/[Dd]([+-]?\d+)$/, 'e$1').trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return NaN;
  return Number(t);
}
