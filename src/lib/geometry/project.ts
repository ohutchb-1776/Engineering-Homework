/**
 * A local tangent-plane projection in feet.
 *
 * Parcel work needs real distances (a 20 ft rear yard), but the GIS hands us
 * degrees. Reprojecting the whole city is overkill: at the scale of a single
 * lot an equirectangular projection anchored on that lot is accurate to well
 * under an inch, which is far finer than the parcel boundaries themselves.
 */

export type LonLat = readonly [number, number];
export type FeetXY = readonly [number, number];

const FT_PER_M = 3.280839895013123;

/** Meters per degree of latitude at latitude `lat` (WGS84 series expansion). */
function metersPerDegreeLat(lat: number): number {
  const p = (lat * Math.PI) / 180;
  return 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p);
}

/** Meters per degree of longitude at latitude `lat`. */
function metersPerDegreeLon(lat: number): number {
  const p = (lat * Math.PI) / 180;
  return 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p);
}

export interface Projector {
  origin: LonLat;
  toFeet(p: LonLat): FeetXY;
  toLonLat(p: FeetXY): LonLat;
}

export function makeProjector(origin: LonLat): Projector {
  const [lon0, lat0] = origin;
  const ftPerDegLat = metersPerDegreeLat(lat0) * FT_PER_M;
  const ftPerDegLon = metersPerDegreeLon(lat0) * FT_PER_M;

  return {
    origin,
    toFeet: ([lon, lat]) => [(lon - lon0) * ftPerDegLon, (lat - lat0) * ftPerDegLat],
    toLonLat: ([x, y]) => [lon0 + x / ftPerDegLon, lat0 + y / ftPerDegLat],
  };
}

/** Signed area of a closed ring, in the ring's own units. Positive = CCW. */
export function signedArea(ring: readonly FeetXY[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]!;
    const b = ring[i + 1]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/** Returns the ring wound counter-clockwise, so the interior is on the left. */
export function toCounterClockwise(ring: readonly FeetXY[]): FeetXY[] {
  const closed = closeRing(ring);
  return signedArea(closed) < 0 ? [...closed].reverse() : closed;
}

export function closeRing(ring: readonly FeetXY[]): FeetXY[] {
  if (ring.length === 0) return [];
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] === last[0] && first[1] === last[1]) return [...ring];
  return [...ring, first];
}
