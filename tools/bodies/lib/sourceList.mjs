// The documents every number of the staged body definitions comes from. `fetch-sources.mjs` downloads each one
// into data/cache/bodies/<id>/ and extracts the tables the generator reads into tools/bodies/sources/<id>.json
// (committed, each with the URL, the time of retrieval and the sha256 of the document it was read from).
export const SOURCES = [
  { id: 'jpl-approx-pos', file: 'approx_pos.html', url: 'https://ssd.jpl.nasa.gov/planets/approx_pos.html' },
  { id: 'jpl-sat-elem', file: 'sat_elem.html', url: 'https://ssd.jpl.nasa.gov/sats/elem/' },
  { id: 'jpl-sat-phys', file: 'sat_phys_par.html', url: 'https://ssd.jpl.nasa.gov/sats/phys_par/' },
  { id: 'jpl-planet-phys', file: 'planet_phys_par.html', url: 'https://ssd.jpl.nasa.gov/planets/phys_par.html' },
  { id: 'jpl-astro-par', file: 'astro_par.html', url: 'https://ssd.jpl.nasa.gov/astro_par.html' },
  { id: 'naif-pck00011', file: 'pck00011.tpc', url: 'https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc' },
  { id: 'sbdb-ceres', file: 'sbdb_1.json', url: 'https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=1&full-prec=true&phys-par=true' },
  { id: 'sbdb-pluto', file: 'sbdb_134340.json', url: 'https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=134340&full-prec=true&phys-par=true' },
];

/** NASA NSSDC fact sheets (albedo, atmospheres, rings); one cache directory per sheet. */
export const NSSDC_SHEETS = [
  'sunfact', 'mercuryfact', 'venusfact', 'earthfact', 'marsfact', 'jupiterfact', 'saturnfact', 'uranusfact',
  'neptunefact', 'plutofact', 'moonfact', 'satringfact', 'joviansatfact', 'saturniansatfact', 'uraniansatfact',
  'neptuniansatfact', 'marsfact',
].filter((v, i, a) => a.indexOf(v) === i);

export const nssdcSource = (sheet) => ({
  id: `nssdc-${sheet}`,
  file: `${sheet}.html`,
  url: `https://nssdc.gsfc.nasa.gov/planetary/factsheet/${sheet}.html`,
});
