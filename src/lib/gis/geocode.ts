/**
 * Fallback geocoding via the US Census Bureau geocoder.
 *
 * Used only when the parcel layer's own address field doesn't match what the
 * user typed. It is free, keyless, and authoritative enough to land a point
 * inside the right lot; the parcel layer still decides which parcel that is.
 */
import { CENSUS_GEOCODER, GIS_TIMEOUT_MS, PORTLAND_BBOX } from "./config";
import type { LonLat } from "../geometry/project";

export interface GeocodeHit {
  matchedAddress: string;
  point: LonLat;
  source: string;
}

export async function geocodeAddress(address: string): Promise<GeocodeHit | null> {
  const params = new URLSearchParams({
    address: `${address}, Portland, ME`,
    benchmark: "Public_AR_Current",
    format: "json",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GIS_TIMEOUT_MS);
  try {
    const response = await fetch(`${CENSUS_GEOCODER}?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;

    const body = (await response.json()) as {
      result?: {
        addressMatches?: { matchedAddress?: string; coordinates?: { x: number; y: number } }[];
      };
    };

    for (const match of body.result?.addressMatches ?? []) {
      const x = match.coordinates?.x;
      const y = match.coordinates?.y;
      if (typeof x !== "number" || typeof y !== "number") continue;
      if (!inPortland([x, y])) continue;
      return {
        matchedAddress: match.matchedAddress ?? address,
        point: [x, y],
        source: "US Census Bureau geocoder",
      };
    }
    return null;
  } catch {
    // A geocoder outage is not fatal — the caller reports the gap instead.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function inPortland([lon, lat]: LonLat): boolean {
  return (
    lon >= PORTLAND_BBOX.minLon &&
    lon <= PORTLAND_BBOX.maxLon &&
    lat >= PORTLAND_BBOX.minLat &&
    lat <= PORTLAND_BBOX.maxLat
  );
}
