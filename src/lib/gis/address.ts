/**
 * Address normalisation, kept deliberately small.
 *
 * The goal is only to make a user's typing match what an assessor's database
 * holds: same case, no punctuation, one spelling per street suffix. Anything
 * more ambitious belongs in a real geocoder.
 */

const SUFFIXES: Record<string, string> = {
  STREET: "ST", STR: "ST", ST: "ST",
  AVENUE: "AVE", AVEN: "AVE", AV: "AVE", AVE: "AVE",
  ROAD: "RD", RD: "RD",
  DRIVE: "DR", DRV: "DR", DR: "DR",
  LANE: "LN", LN: "LN",
  COURT: "CT", CT: "CT",
  PLACE: "PL", PL: "PL",
  BOULEVARD: "BLVD", BLVD: "BLVD",
  TERRACE: "TER", TERR: "TER", TER: "TER",
  CIRCLE: "CIR", CIR: "CIR",
  PARKWAY: "PKWY", PKWY: "PKWY",
  HIGHWAY: "HWY", HWY: "HWY",
  SQUARE: "SQ", SQ: "SQ",
  WAY: "WAY",
  PROMENADE: "PROM", PROM: "PROM",
};

const DIRECTIONS: Record<string, string> = {
  NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W",
  NORTHEAST: "NE", NORTHWEST: "NW", SOUTHEAST: "SE", SOUTHWEST: "SW",
};

/** Strip city/state/ZIP so only the street line is matched against the GIS. */
export function streetLineOf(input: string): string {
  const [first] = input.split(",");
  return (first ?? input).trim();
}

/** Uppercase, de-punctuate, and canonicalise suffixes and directionals. */
export function normalizeAddress(input: string): string {
  const words = streetLineOf(input)
    .toUpperCase()
    .replace(/[.,#]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ");

  return words
    .map((word, index) => {
      // Never rewrite the leading house number.
      if (index === 0) return word;
      return SUFFIXES[word] ?? DIRECTIONS[word] ?? word;
    })
    .join(" ")
    .trim();
}

/** The canonical suffix abbreviations, e.g. ST, AVE, SQ. */
export const CANONICAL_SUFFIXES = new Set(Object.values(SUFFIXES));

/**
 * The address with a trailing street-suffix token removed, or null if there
 * is none to remove.
 *
 * Assessors are inconsistent about suffixes in a way no abbreviation table
 * fixes: a parcel on Monument Square may be recorded as "5 MONUMENT SQ",
 * "5 MONUMENT SQUARE", or just "5 MONUMENT". Dropping the suffix gives a
 * prefix that matches all three.
 */
export function withoutStreetSuffix(input: string): string | null {
  const words = normalizeAddress(input).split(" ");
  if (words.length < 3) return null;
  const last = words[words.length - 1]!;
  if (!CANONICAL_SUFFIXES.has(last)) return null;
  return words.slice(0, -1).join(" ");
}

/** The leading house number, if the input starts with one. */
export function houseNumberOf(input: string): string | null {
  const match = /^(\d+[A-Z]?)\b/.exec(normalizeAddress(input));
  return match?.[1] ?? null;
}

/** True when the text looks like a street address rather than a place name. */
export function looksLikeStreetAddress(input: string): boolean {
  return /^\s*\d/.test(streetLineOf(input));
}
