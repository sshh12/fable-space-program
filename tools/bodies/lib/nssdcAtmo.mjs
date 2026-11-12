// Reads the atmosphere lines of the NASA NSSDC fact sheets (kept verbatim in tools/bodies/sources/nssdc.json)
// into numbers. A range "19.1 - 20.3" is taken at its midpoint (recorded in the note).

const numberIn = (line, what) => {
  const m = /:\s*~?\s*([0-9.]+)(?:\s*-\s*([0-9.]+))?/.exec(line);
  if (!m) throw new Error(`nssdc: no number in "${line}" (${what})`);
  return m[2] ? { value: (Number(m[1]) + Number(m[2])) / 2, range: [Number(m[1]), Number(m[2])] } : { value: Number(m[1]) };
};

/** Mole fractions from a "Major: ..." line: "Carbon Dioxide (CO 2 ) - 95.1%" or "96.5% Carbon Dioxide (CO 2 )". */
export function composition(line) {
  const out = {};
  const species = { 'CO 2': 'CO2', 'N 2': 'N2', 'H 2': 'H2', He: 'He', 'CH 4': 'CH4', Ar: 'Ar' };
  for (const [label, key] of Object.entries(species)) {
    const esc = label.replace(/ /g, '\\s*');
    const after = new RegExp(`\\(${esc}\\s*\\)\\s*-?\\s*([0-9.]+)%`).exec(line);
    const before = new RegExp(`([0-9.]+)%\\s*[A-Za-z ]*\\(${esc}\\s*\\)`).exec(line);
    const m = after ?? before;
    if (m) out[key] = Number(m[1]) / 100;
  }
  if (Object.keys(out).length === 0) throw new Error(`nssdc: no composition in "${line}"`);
  return out;
}

/** { rho0, p0, scaleHeightKm, temperature, meanMolecularWeight, composition, notes } of a sheet's lines. */
export function nssdcAtmosphere(sheet, lines) {
  const find = (re) => {
    const l = lines.find((x) => re.test(x));
    if (!l) throw new Error(`nssdc ${sheet}: no line ${re}`);
    return l;
  };
  const notes = [];
  const take = (re, what) => {
    const v = numberIn(find(re), what);
    if (v.range) notes.push(`${what}: midpoint of the range ${v.range[0]}-${v.range[1]}`);
    return v.value;
  };
  const surface = lines.some((l) => /^Surface density:/.test(l));
  const out = {
    rho0: take(surface ? /^Surface density:/ : /^Density at 1 bar:/, 'density'),
    p0: surface ? take(/^Surface pressure:/, 'pressure') * 100 : 1e5,
    scaleHeightKm: take(/^Scale height:/, 'scale height'),
    temperature: take(surface ? /^Average temperature:/ : /^Temperature at 1 bar:/, 'temperature'),
    meanMolecularWeight: take(/^Mean molecular weight:/, 'mean molecular weight'),
    // The "Major" line and the one after it (methane on the giants' sheets, argon on Mars').
    composition: composition(`${find(/^Major/)} ${lines[lines.indexOf(find(/^Major/)) + 1] ?? ''}`),
    reference: surface ? 'surface (mean radius)' : '1 bar level',
  };
  if (surface && !/mb/.test(find(/^Surface pressure:/))) throw new Error(`nssdc ${sheet}: surface pressure unit is not mb`);
  return { ...out, notes };
}
