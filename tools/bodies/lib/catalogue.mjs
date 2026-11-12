// The thirty-two bodies of ARCHITECTURE 8.1, in the order of the brief, with the identifiers the sources use.
// This file holds names and classifications only; every number comes from the source tables.
//
//   naif      NAIF / JPL id (pck00011 BODY<naif>_..., Horizons command, satellite tables)
//   horizons  Horizons COMMAND for the body centre ('1;' = small body 1, Ceres)
//   center    Horizons CENTER for the validation (the parent's body centre)
//   kind      star | planet | moon | dwarf
//   orbitSource  approx-pos (JPL Table 1 row), sun-low-precision (Earth, v1 formula inverted),
//                frozen-v1 (the Moon: data/defs/bodies/moon.json unchanged), sat-elem (JPL satellite mean
//                elements), sbdb (osculating elements)
//   surface   solid | none (the four giants)
//   class     rocky | icy (amplification model of a new solid body; null otherwise). By surface composition
//             (NASA NSSDC fact sheets): silicate surfaces rocky, water-ice surfaces icy.

export const BODY_ORDER = [
  'sun',
  'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune',
  'moon',
  'phobos', 'deimos',
  'io', 'europa', 'ganymede', 'callisto',
  'mimas', 'enceladus', 'tethys', 'dione', 'rhea', 'titan', 'iapetus',
  'miranda', 'ariel', 'umbriel', 'titania', 'oberon',
  'triton',
  'ceres',
  'pluto', 'charon',
];

const B = (id, name, naif, horizons, parent, kind, extra) => ({ id, name, naif, horizons, parent, kind, ...extra });

export const CATALOGUE = {
  sun: B('sun', 'Sun', 10, '10', null, 'star', { surface: 'none', class: null }),
  mercury: B('mercury', 'Mercury', 199, '199', 'sun', 'planet', { approxPos: 'Mercury', surface: 'solid', class: 'rocky' }),
  venus: B('venus', 'Venus', 299, '299', 'sun', 'planet', { approxPos: 'Venus', surface: 'solid', class: 'rocky' }),
  earth: B('earth', 'Earth', 399, '399', 'sun', 'planet', { approxPos: 'EM Bary', surface: 'solid', class: null }),
  mars: B('mars', 'Mars', 499, '499', 'sun', 'planet', { approxPos: 'Mars', surface: 'solid', class: 'rocky' }),
  jupiter: B('jupiter', 'Jupiter', 599, '599', 'sun', 'planet', { approxPos: 'Jupiter', surface: 'none', class: null }),
  saturn: B('saturn', 'Saturn', 699, '699', 'sun', 'planet', { approxPos: 'Saturn', surface: 'none', class: null }),
  uranus: B('uranus', 'Uranus', 799, '799', 'sun', 'planet', { approxPos: 'Uranus', surface: 'none', class: null }),
  neptune: B('neptune', 'Neptune', 899, '899', 'sun', 'planet', { approxPos: 'Neptune', surface: 'none', class: null }),
  moon: B('moon', 'Moon', 301, '301', 'earth', 'moon', { satName: 'Moon', surface: 'solid', class: null }),
  phobos: B('phobos', 'Phobos', 401, '401', 'mars', 'moon', { satName: 'Phobos', surface: 'solid', class: 'rocky' }),
  deimos: B('deimos', 'Deimos', 402, '402', 'mars', 'moon', { satName: 'Deimos', surface: 'solid', class: 'rocky' }),
  io: B('io', 'Io', 501, '501', 'jupiter', 'moon', { satName: 'Io', surface: 'solid', class: 'rocky' }),
  europa: B('europa', 'Europa', 502, '502', 'jupiter', 'moon', { satName: 'Europa', surface: 'solid', class: 'icy' }),
  ganymede: B('ganymede', 'Ganymede', 503, '503', 'jupiter', 'moon', { satName: 'Ganymede', surface: 'solid', class: 'icy' }),
  callisto: B('callisto', 'Callisto', 504, '504', 'jupiter', 'moon', { satName: 'Callisto', surface: 'solid', class: 'icy' }),
  mimas: B('mimas', 'Mimas', 601, '601', 'saturn', 'moon', { satName: 'Mimas', surface: 'solid', class: 'icy' }),
  enceladus: B('enceladus', 'Enceladus', 602, '602', 'saturn', 'moon', { satName: 'Enceladus', surface: 'solid', class: 'icy' }),
  tethys: B('tethys', 'Tethys', 603, '603', 'saturn', 'moon', { satName: 'Tethys', surface: 'solid', class: 'icy' }),
  dione: B('dione', 'Dione', 604, '604', 'saturn', 'moon', { satName: 'Dione', surface: 'solid', class: 'icy' }),
  rhea: B('rhea', 'Rhea', 605, '605', 'saturn', 'moon', { satName: 'Rhea', surface: 'solid', class: 'icy' }),
  titan: B('titan', 'Titan', 606, '606', 'saturn', 'moon', { satName: 'Titan', surface: 'solid', class: 'icy' }),
  iapetus: B('iapetus', 'Iapetus', 608, '608', 'saturn', 'moon', { satName: 'Iapetus', surface: 'solid', class: 'icy' }),
  miranda: B('miranda', 'Miranda', 705, '705', 'uranus', 'moon', { satName: 'Miranda', surface: 'solid', class: 'icy' }),
  ariel: B('ariel', 'Ariel', 701, '701', 'uranus', 'moon', { satName: 'Ariel', surface: 'solid', class: 'icy' }),
  umbriel: B('umbriel', 'Umbriel', 702, '702', 'uranus', 'moon', { satName: 'Umbriel', surface: 'solid', class: 'icy' }),
  titania: B('titania', 'Titania', 703, '703', 'uranus', 'moon', { satName: 'Titania', surface: 'solid', class: 'icy' }),
  oberon: B('oberon', 'Oberon', 704, '704', 'uranus', 'moon', { satName: 'Oberon', surface: 'solid', class: 'icy' }),
  triton: B('triton', 'Triton', 801, '801', 'neptune', 'moon', { satName: 'Triton', surface: 'solid', class: 'icy' }),
  ceres: B('ceres', 'Ceres', 2000001, '1;', 'sun', 'dwarf', { sbdb: 'sbdb-ceres', surface: 'solid', class: 'rocky' }),
  pluto: B('pluto', 'Pluto', 999, '999', 'sun', 'dwarf', { sbdb: 'sbdb-pluto', surface: 'solid', class: 'icy' }),
  charon: B('charon', 'Charon', 901, '901', 'pluto', 'moon', { satName: 'Charon', surface: 'solid', class: 'icy' }),
};

/** Horizons CENTER of a body's parent (body centre, not barycentre). */
export function horizonsCenter(id) {
  const p = CATALOGUE[id].parent;
  return p === null ? null : `500@${CATALOGUE[p].naif}`;
}

export const SAT_NAMES = BODY_ORDER.filter((id) => CATALOGUE[id].satName).map((id) => CATALOGUE[id].satName);
export const NAIF_IDS = BODY_ORDER.map((id) => CATALOGUE[id].naif);
