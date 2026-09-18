/**
 * Turning a parcel outline plus required yards into a buildable footprint.
 *
 * The approach is half-plane clipping: every edge of the lot is pushed inward
 * by the yard required on that edge, and the buildable area is what survives
 * all of those cuts. For a convex lot this is exactly the setback envelope.
 * For a concave lot it trims slightly more than the code strictly requires,
 * which is the direction an early feasibility number should err in.
 */
import polygonClipping, { type Geom, type Ring } from "polygon-clipping";
import { type FeetXY, closeRing, signedArea, toCounterClockwise } from "./project";

export type EdgeClass = "front" | "side" | "rear";

export interface RequiredYardsFt {
  front: number;
  side: number;
  rear: number;
}

/**
 * Classify each edge of a lot as front/side/rear.
 *
 * `streetLines` are nearby street centrelines in the same projected feet
 * space. The edges closest to a centreline are the frontage; the edge
 * furthest from one is the rear; everything else is a side. When no street
 * geometry is available the caller gets `null` back and should fall back to
 * applying the largest required yard uniformly — see `uniformYard`.
 */
export function classifyEdges(
  ring: readonly FeetXY[],
  streetLines: readonly (readonly FeetXY[])[],
  frontToleranceFt = 15,
): EdgeClass[] | null {
  const closed = closeRing(ring);
  const edgeCount = closed.length - 1;
  if (edgeCount < 3) return null;
  if (streetLines.length === 0) return null;

  const distances: number[] = [];
  for (let i = 0; i < edgeCount; i++) {
    const a = closed[i]!;
    const b = closed[i + 1]!;
    const mid: FeetXY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let best = Infinity;
    for (const line of streetLines) {
      for (let j = 0; j < line.length - 1; j++) {
        best = Math.min(best, distancePointToSegment(mid, line[j]!, line[j + 1]!));
      }
    }
    distances.push(best);
  }

  const min = Math.min(...distances);
  const max = Math.max(...distances);
  if (!Number.isFinite(min)) return null;

  return distances.map((d) => {
    if (d <= min + frontToleranceFt) return "front";
    if (d >= max - frontToleranceFt) return "rear";
    return "side";
  });
}

/** The yard to apply on every edge when frontage cannot be determined. */
export function uniformYard(yards: RequiredYardsFt): number {
  return Math.max(yards.front, yards.side, yards.rear);
}

export interface SetbackResult {
  /**
   * Buildable polygons in projected feet. Each entry is `[outerRing, ...holes]`,
   * matching GeoJSON's ring order. Empty when the yards consume the lot.
   */
  polygons: FeetXY[][][];
  /**
   * Planar area of the result, square feet. The pipeline re-measures the
   * unprojected polygon geodesically so that every area in the app comes from
   * the same library; this value exists for tests and for sanity checks.
   */
  areaSf: number;
}

/**
 * Push each edge inward by its required yard and return what is left.
 *
 * `perEdgeYardFt[i]` is the yard for the edge from vertex i to vertex i+1 of
 * the counter-clockwise ring.
 */
export function applySetbacks(
  outerRing: readonly FeetXY[],
  perEdgeYardFt: readonly number[],
): SetbackResult {
  const ccw = toCounterClockwise(outerRing);
  const edgeCount = ccw.length - 1;
  if (edgeCount < 3) return { polygons: [], areaSf: 0 };

  const extent = ringExtent(ccw);
  // Half-planes are represented as very large rectangles; they only need to be
  // comfortably bigger than the lot for the intersection to be exact.
  const reach = extent * 4 + 1000;

  let current: Geom = [[ccw.map(toTuple)]];

  for (let i = 0; i < edgeCount; i++) {
    const yard = perEdgeYardFt[i] ?? 0;
    if (yard <= 0) continue;

    const a = ccw[i]!;
    const b = ccw[i + 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;

    const ux = dx / len;
    const uy = dy / len;
    // Interior is to the left of a counter-clockwise edge.
    const nx = -uy;
    const ny = ux;

    const ox = a[0] + nx * yard;
    const oy = a[1] + ny * yard;

    const halfPlane: Ring = [
      [ox - ux * reach, oy - uy * reach],
      [ox + ux * reach, oy + uy * reach],
      [ox + ux * reach + nx * reach, oy + uy * reach + ny * reach],
      [ox - ux * reach + nx * reach, oy - uy * reach + ny * reach],
    ];
    halfPlane.push(halfPlane[0]!);

    const clipped = polygonClipping.intersection(current, [halfPlane]);
    if (clipped.length === 0) return { polygons: [], areaSf: 0 };
    current = clipped as Geom;
  }

  const polygons: FeetXY[][][] = [];
  let areaSf = 0;
  for (const poly of current as number[][][][]) {
    const rings = poly.map((ring, index) => {
      const closed = closeRing(ring.map((p) => [p[0]!, p[1]!] as FeetXY));
      // Index 0 is the outer ring; the rest are holes and subtract area.
      areaSf += index === 0 ? Math.abs(signedArea(closed)) : -Math.abs(signedArea(closed));
      return closed;
    });
    if (rings.length > 0) polygons.push(rings);
  }

  return { polygons, areaSf: Math.max(0, areaSf) };
}

function toTuple(p: FeetXY): [number, number] {
  return [p[0], p[1]];
}

function ringExtent(ring: readonly FeetXY[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return Math.max(maxX - minX, maxY - minY);
}

function distancePointToSegment(p: FeetXY, a: FeetXY, b: FeetXY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
