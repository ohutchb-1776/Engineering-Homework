/**
 * Address -> everything the calculator needs to know about the ground.
 *
 * Two strategies for finding the parcel, in order:
 *   1. Match the typed address against the parcel layer's own address field.
 *      This is exact and needs no third party.
 *   2. Geocode the address and take the parcel the point falls in.
 *
 * Optional layers never fail the lookup. A layer we couldn't reach is
 * recorded as a *gap*, and a gap is shown to the user — "we found no shoreland
 * overlay" and "we couldn't check for a shoreland overlay" are different
 * answers and the UI says which one it is.
 */
import type { Feature, Geometry, Polygon, MultiPolygon } from "geojson";
import area from "@turf/area";
import centroid from "@turf/centroid";
import { LAYER_SPEC_BY_KEY } from "./config";
import { resolveLayer, type ResolvedLayer } from "./discovery";
import { GisError, getLayerInfo, queryLayer, sqlQuote, type GisFeature, type LayerInfo } from "./arcgis";
import { asNumber, asString, readField, resolveField } from "./fields";
import { geocodeAddress, inPortland, type GeocodeHit } from "./geocode";
import { houseNumberOf, normalizeAddress, withoutStreetSuffix } from "./address";
import { makeProjector, type LonLat } from "../geometry/project";

export interface SourceRecord {
  key: string;
  label: string;
  url: string;
  /** What we got: a hit, nothing there, or an outage. */
  status: "ok" | "empty" | "unavailable";
  detail?: string;
  /** How the endpoint was found. See src/lib/gis/discovery.ts. */
  via?: ResolvedLayer["via"];
}

export interface OverlayHit {
  /** Rule-dataset overlay id, when we could map it. */
  ruleId: string | null;
  /** Name exactly as the GIS layer reports it. */
  name: string;
  layerKey: string;
}

export interface SiteData {
  parcel: {
    feature: Feature<Polygon | MultiPolygon, Record<string, unknown>>;
    address: string | null;
    parcelId: string | null;
    /** Geodesic area of the parcel polygon, square feet. */
    computedAreaSf: number;
    /** Lot area as the assessor records it, when the layer carries one. */
    recordedAreaSf: number | null;
    centroid: LonLat;
  };
  zoning: {
    districtCode: string | null;
    districtName: string | null;
    /** Height published on the zoning layer itself, if any. Beats the table. */
    mappedMaxHeightFt: number | null;
    /** Every string attribute on the zoning polygon, for loose matching. */
    rawValues: string[];
    /** How the district was found: on the parcel, or the nearest polygon. */
    method: "parcel" | "centroid" | "nearest" | "none";
  };
  overlays: OverlayHit[];
  /** Street centrelines near the parcel, in WGS84, for frontage detection. */
  streetLines: LonLat[][];
  sources: SourceRecord[];
  /** Human-readable notes about what could not be determined. */
  gaps: string[];
  /** How the parcel was found. */
  matchMethod: "parcel-address-field" | "geocode-point-in-parcel" | "geocode-nearest-parcel";
  matchedAddress: string;
}

export class SiteLookupError extends Error {
  constructor(
    message: string,
    readonly kind: "not-found" | "ambiguous" | "upstream",
    readonly sources: SourceRecord[] = [],
    readonly candidates: string[] = [],
    /** Everything the lookup learned before it failed. Shown, so the next fix is informed. */
    readonly gaps: string[] = [],
  ) {
    super(message);
    this.name = "SiteLookupError";
  }
}

export const SQ_FT_PER_SQ_M = 10.763910416709722;

export async function lookupSite(rawAddress: string): Promise<SiteData> {
  const sources: SourceRecord[] = [];
  const gaps: string[] = [];
  const normalized = normalizeAddress(rawAddress);

  if (normalized.length < 3) {
    throw new SiteLookupError("Enter a street address in Portland, Maine.", "not-found");
  }

  const parcelLayer = await locate("parcels");
  const parcelInfo = await getLayerInfoOrThrow(parcelLayer, sources);
  const { feature: parcelFeature, method } = await findParcel(
    normalized,
    parcelLayer,
    parcelInfo,
    sources,
    gaps,
  );

  const geometry = parcelFeature.geometry;
  if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) {
    throw new SiteLookupError(
      "The parcel layer returned a record without a usable boundary.",
      "upstream",
      sources,
    );
  }

  const polygon = parcelFeature as Feature<Polygon | MultiPolygon, Record<string, unknown>>;
  const computedAreaSf = area(polygon) * SQ_FT_PER_SQ_M;
  const centre = centroid(polygon).geometry.coordinates as [number, number];

  const address = asString(readField(polygon.properties, parcelInfo.fields, "address"));
  const parcelId = asString(readField(polygon.properties, parcelInfo.fields, "parcelId"));
  const recordedAreaSf = readRecordedArea(polygon.properties, parcelInfo);

  const [zoning, overlays, streetLines] = await Promise.all([
    lookupZoning(polygon.geometry, centre, sources, gaps),
    lookupOverlays(polygon.geometry, sources, gaps),
    lookupStreets(centre, sources, gaps),
  ]);

  return {
    parcel: {
      feature: polygon,
      address,
      parcelId,
      computedAreaSf,
      recordedAreaSf,
      centroid: centre,
    },
    zoning,
    overlays,
    streetLines,
    sources,
    gaps,
    matchMethod: method,
    matchedAddress: address ?? normalized,
  };
}

/** Find a layer's current URL, or null if nothing resolved. */
async function locate(key: string): Promise<ResolvedLayer> {
  const spec = LAYER_SPEC_BY_KEY[key];
  if (!spec) throw new Error(`no layer spec named "${key}"`);
  return resolveLayer(spec);
}

async function getLayerInfoOrThrow(
  layer: ResolvedLayer,
  sources: SourceRecord[],
): Promise<LayerInfo> {
  if (!layer.url) {
    sources.push({
      key: layer.key,
      label: layer.label,
      url: "",
      status: "unavailable",
      via: layer.via,
      detail: layer.attempts.map((a) => `${a.url}: ${a.outcome}`).join(" | "),
    });
    throw new SiteLookupError(
      `Could not find the ${layer.label} layer on any known endpoint, so no parcel could be identified. Open /diagnostics to see everything that was tried.`,
      "upstream",
      sources,
    );
  }
  try {
    return await getLayerInfo(layer.url);
  } catch (error) {
    sources.push({
      key: layer.key,
      label: layer.label,
      url: layer.url,
      status: "unavailable",
      via: layer.via,
      detail: error instanceof GisError ? error.message : String(error),
    });
    throw new SiteLookupError(
      `Could not reach the ${layer.label} layer, so no parcel could be identified. Open /diagnostics to see what is reachable.`,
      "upstream",
      sources,
    );
  }
}

async function findParcel(
  normalized: string,
  parcelLayer: ResolvedLayer,
  parcelInfo: LayerInfo,
  sources: SourceRecord[],
  gaps: string[],
): Promise<{
  feature: GisFeature;
  method: SiteData["matchMethod"];
}> {
  const parcelUrl = parcelLayer.url!;
  const addressField = resolveField(parcelInfo.fields, "address");

  if (addressField) {
    // Two passes. The strict one is the typed address; the loose one drops the
    // street suffix, because assessors record "5 MONUMENT SQ", "5 MONUMENT
    // SQUARE" and "5 MONUMENT" interchangeably and no abbreviation table
    // reconciles them.
    const patterns = [normalized, withoutStreetSuffix(normalized)].filter(
      (value): value is string => value !== null,
    );

    for (const pattern of patterns) {
      const where = `UPPER(${addressField}) LIKE ${sqlQuote(`${pattern}%`)}`;
      const matches = await queryLayer(parcelUrl, { where, resultRecordCount: 25 });
      if (matches.length === 0) continue;

      const detail =
        pattern === normalized
          ? `matched on ${addressField}`
          : `matched on ${addressField} after dropping the street suffix`;

      if (matches.length === 1) {
        sources.push(okSource(parcelLayer, detail));
        return { feature: matches[0]!, method: "parcel-address-field" };
      }

      // Several records can share a street address (condominium units sharing
      // one lot). Identical geometry means it is really one parcel.
      const distinct = dedupeByGeometry(matches);
      if (distinct.length === 1) {
        sources.push(okSource(parcelLayer, detail));
        return { feature: distinct[0]!, method: "parcel-address-field" };
      }

      // A loosened pattern matching several different lots is a real
      // ambiguity ("5 MONUMENT" also matching "5 MONUMENT WAY"), so ask
      // rather than pick.
      const labels = distinct
        .map((f) => asString(readField(f.properties, parcelInfo.fields, "address")))
        .filter((value): value is string => value !== null);
      throw new SiteLookupError(
        "That address matches more than one parcel. Pick the exact one.",
        "ambiguous",
        sources,
        [...new Set(labels)].slice(0, 12),
      );
    }

    // Falling through to the geocoder is a worse answer, so say why it
    // happened: either the field is the wrong one, or the assessor records
    // this address differently. Naming the field is what distinguishes them.
    gaps.push(
      `No parcel's ${addressField} begins with ${patterns
        .map((p) => `"${p}"`)
        .join(" or ")}, so the address was geocoded instead. If that field is not the one holding street addresses, add the right name to FIELD_CANDIDATES in src/lib/gis/fields.ts.`,
    );
  }

  const split = await findParcelBySplitFields(normalized, parcelLayer, parcelInfo, sources);
  if (split) return { feature: split, method: "parcel-address-field" };

  if (!addressField) {
    gaps.push(
      "The parcel layer has no address field this app recognises, so the address was geocoded instead.",
    );
  }

  const hit = (await geocodeWithAddressPoints(normalized, sources, gaps)) ?? (await geocodeAddress(normalized));
  if (!hit) {
    sources.push({ ...okSource(parcelLayer), status: "empty" });
    throw new SiteLookupError(
      `No Portland parcel matched "${normalized}". Check the street number and spelling.`,
      "not-found",
      sources,
      [],
      gaps,
    );
  }
  if (!inPortland(hit.point)) {
    throw new SiteLookupError(
      "That address geocodes outside Portland, Maine. This tool only covers Portland.",
      "not-found",
      sources,
    );
  }

  const atPoint = await queryLayer(parcelUrl, {
    intersects: { type: "Point", coordinates: [hit.point[0], hit.point[1]] },
    resultRecordCount: 5,
  });

  if (atPoint.length > 0) {
    sources.push(okSource(parcelLayer, `matched by point from the ${hit.source}`));
    return { feature: atPoint[0]!, method: "geocode-point-in-parcel" };
  }

  // Addresses on squares, plazas, pedestrian ways and long private drives
  // geocode to a point in the public right-of-way, which is not a parcel. The
  // lot is still right there, so take the nearest one and say that we did.
  const nearby = await queryLayer(parcelUrl, {
    intersects: bufferBox(hit.point, NEAREST_PARCEL_SEARCH_DEGREES),
    resultRecordCount: 50,
  });
  const nearest = nearestFeature(nearby, hit.point, NEAREST_PARCEL_MAX_FT);

  if (nearest) {
    sources.push(okSource(parcelLayer, `nearest parcel to the point from the ${hit.source}`));
    gaps.push(
      `"${normalized}" geocoded to a point that is not inside any parcel — usual for addresses on a square or other public way. The nearest parcel, about ${Math.round(
        nearest.distanceFt,
      )} ft away, was used instead. Check the map to confirm it is the right lot.`,
    );
    return { feature: nearest.feature, method: "geocode-nearest-parcel" };
  }

  sources.push({ ...okSource(parcelLayer), status: "empty" });
  throw new SiteLookupError(
    `"${normalized}" geocoded successfully, but no Portland parcel lies within ${NEAREST_PARCEL_MAX_FT} ft of it. Try the street address of the building rather than a square or landmark name.`,
    "not-found",
    sources,
  );
}

/** Half-width of the box searched for a nearby parcel: roughly 500 ft. */
const NEAREST_PARCEL_SEARCH_DEGREES = 0.0015;
/** How far from the geocoded point a parcel may be and still be believable. */
const NEAREST_PARCEL_MAX_FT = 500;

/**
 * Match on separate number and street fields, which many assessor layers use
 * instead of one combined address. The street is matched as a prefix on its
 * stem ("MONUMENT" for "MONUMENT SQ") so suffix spelling cannot get in the
 * way; the number is matched exactly, typed to suit the field.
 */
async function findParcelBySplitFields(
  normalized: string,
  parcelLayer: ResolvedLayer,
  parcelInfo: LayerInfo,
  sources: SourceRecord[],
): Promise<GisFeature | null> {
  const numberField = resolveField(parcelInfo.fields, "houseNumber");
  const streetField = resolveField(parcelInfo.fields, "parcelStreet");
  const number = houseNumberOf(normalized);
  if (!numberField || !streetField || !number) return null;

  const stem = (withoutStreetSuffix(normalized) ?? normalized).split(" ").slice(1).join(" ");
  if (stem.length === 0) return null;

  const numberType = parcelInfo.fields.find((f) => f.name === numberField)?.type ?? "";
  const numberIsText = /String/i.test(numberType);
  const numberLiteral = numberIsText ? sqlQuote(number) : String(Number.parseInt(number, 10));
  if (!numberIsText && !/^\d+$/.test(number)) return null;

  const where = `UPPER(${streetField}) LIKE ${sqlQuote(`${stem}%`)} AND ${numberField} = ${numberLiteral}`;
  const matches = dedupeByGeometry(
    await queryLayer(parcelLayer.url!, { where, resultRecordCount: 25 }),
  );
  if (matches.length === 0) return null;

  sources.push(okSource(parcelLayer, `matched on ${numberField} + ${streetField}`));
  return matches[0]!;
}

/**
 * Geocode with the city's own address points, if a layer was found. A point
 * the city placed on the building beats a national geocoder interpolating
 * along the street, and it is what makes an address on a square land on the
 * lot rather than in the plaza.
 */
async function geocodeWithAddressPoints(
  normalized: string,
  sources: SourceRecord[],
  gaps: string[],
): Promise<GeocodeHit | null> {
  const layer = await locate("addressPoints");
  if (!layer.url) return null;

  try {
    const info = await getLayerInfo(layer.url);
    const addressField = resolveField(info.fields, "address");
    const numberField = resolveField(info.fields, "houseNumber");
    const streetField = resolveField(info.fields, "parcelStreet") ?? resolveField(info.fields, "streetName");
    const number = houseNumberOf(normalized);
    const stem = (withoutStreetSuffix(normalized) ?? normalized).split(" ").slice(1).join(" ");

    const clauses: string[] = [];
    if (addressField) {
      clauses.push(`UPPER(${addressField}) LIKE ${sqlQuote(`${normalized}%`)}`);
      const loose = withoutStreetSuffix(normalized);
      if (loose) clauses.push(`UPPER(${addressField}) LIKE ${sqlQuote(`${loose}%`)}`);
    }
    if (numberField && streetField && number && stem) {
      const numberType = info.fields.find((f) => f.name === numberField)?.type ?? "";
      const literal = /String/i.test(numberType) ? sqlQuote(number) : String(Number.parseInt(number, 10));
      if (/String/i.test(numberType) || /^\d+$/.test(number)) {
        clauses.push(`UPPER(${streetField}) LIKE ${sqlQuote(`${stem}%`)} AND ${numberField} = ${literal}`);
      }
    }
    if (clauses.length === 0) {
      sources.push({ ...okSource(layer), status: "empty", detail: "no address fields recognised" });
      return null;
    }

    for (const where of clauses) {
      const points = await queryLayer(layer.url, { where, resultRecordCount: 5 });
      const point = points.find((f) => f.geometry?.type === "Point");
      if (point && point.geometry?.type === "Point") {
        const [x, y] = point.geometry.coordinates;
        if (typeof x === "number" && typeof y === "number" && inPortland([x, y])) {
          sources.push(okSource(layer, "address point located"));
          return { matchedAddress: normalized, point: [x, y], source: "city address points" };
        }
      }
    }
    sources.push({ ...okSource(layer), status: "empty" });
    return null;
  } catch (error) {
    sources.push(failedSource(layer, error));
    gaps.push("The city address-point layer could not be read, so a national geocoder was used instead.");
    return null;
  }
}

/** The feature whose centroid is closest to `point`, within `maxFt`. */
function nearestFeature(
  features: GisFeature[],
  point: LonLat,
  maxFt: number,
): { feature: GisFeature; distanceFt: number } | null {
  const projector = makeProjector(point);
  let best: { feature: GisFeature; distanceFt: number } | null = null;

  for (const feature of features) {
    if (!feature.geometry) continue;
    const middle = centroid(feature as Feature<Polygon | MultiPolygon>).geometry.coordinates;
    const [x, y] = projector.toFeet([middle[0]!, middle[1]!]);
    const distanceFt = Math.hypot(x, y);
    if (distanceFt <= maxFt && (best === null || distanceFt < best.distanceFt)) {
      best = { feature, distanceFt };
    }
  }
  return best;
}

const NO_ZONING: SiteData["zoning"] = {
  districtCode: null,
  districtName: null,
  mappedMaxHeightFt: null,
  rawValues: [],
  method: "none",
};

async function lookupZoning(
  parcelGeometry: Polygon | MultiPolygon,
  centre: LonLat,
  sources: SourceRecord[],
  gaps: string[],
): Promise<SiteData["zoning"]> {
  const layer = await locate("zoning");
  if (!layer.url) {
    sources.push(unresolvedSource(layer));
    gaps.push(
      "The city zoning layer could not be found on any known endpoint, so the district was estimated rather than read.",
    );
    return NO_ZONING;
  }

  try {
    const info = await getLayerInfo(layer.url);

    // Three tries, each wider than the last: polygons intersecting the lot
    // (the usual case), the lot's centre point (concave lots), then anything
    // within about 200 ft (lots the zoning map leaves a sliver around).
    const attempts: { method: SiteData["zoning"]["method"]; geometry: Geometry }[] = [
      { method: "parcel", geometry: parcelGeometry },
      { method: "centroid", geometry: { type: "Point", coordinates: [centre[0], centre[1]] } },
      { method: "nearest", geometry: bufferBox(centre, 0.0006) },
    ];

    for (const attempt of attempts) {
      const features = await queryLayer(layer.url, {
        intersects: attempt.geometry,
        returnGeometry: false,
        resultRecordCount: 10,
      });
      if (features.length === 0) continue;

      // Several districts can touch a lot; the most frequent one governs.
      const counts = new Map<string, { n: number; attributes: Record<string, unknown> }>();
      for (const feature of features) {
        const code =
          asString(readField(feature.properties, info.fields, "zoningDistrict")) ??
          asString(readField(feature.properties, info.fields, "zoningName")) ??
          JSON.stringify(feature.properties);
        const entry = counts.get(code) ?? { n: 0, attributes: feature.properties };
        entry.n += 1;
        counts.set(code, entry);
      }
      const attributes = [...counts.values()].sort((a, b) => b.n - a.n)[0]!.attributes;

      sources.push(okSource(layer, attempt.method === "parcel" ? undefined : `matched by ${attempt.method}`));
      if (attempt.method === "nearest") {
        gaps.push(
          "No zoning polygon covers this parcel; the nearest district was used. Confirm it on the city's zoning map.",
        );
      }
      return {
        districtCode: asString(readField(attributes, info.fields, "zoningDistrict")),
        districtName: asString(readField(attributes, info.fields, "zoningName")),
        mappedMaxHeightFt: asNumber(readField(attributes, info.fields, "maxHeightFt")),
        rawValues: Object.values(attributes)
          .map((v) => asString(v))
          .filter((v): v is string => v !== null),
        method: attempt.method,
      };
    }

    sources.push({ ...okSource(layer), status: "empty" });
    gaps.push("No zoning district polygon lies on or near this parcel, so the district was estimated.");
    return NO_ZONING;
  } catch (error) {
    sources.push(failedSource(layer, error));
    gaps.push("The city zoning layer was unreachable, so the district was estimated rather than read.");
    return NO_ZONING;
  }
}

/** GIS layer -> rule-dataset overlay id. */
const OVERLAY_LAYER_RULE_IDS: Partial<Record<string, string>> = {
  shoreland: "shoreland",
  stream: "stream-protection",
  coastalStability: "coastal-stability",
  historic: "historic-district",
};

async function lookupOverlays(
  geometry: Geometry,
  sources: SourceRecord[],
  gaps: string[],
): Promise<OverlayHit[]> {
  const optional = await Promise.all(
    ["shoreland", "stream", "coastalStability", "historic", "overlays", "flood"].map((key) =>
      locate(key),
    ),
  );

  const results = await Promise.all(
    optional.map(async (layer): Promise<OverlayHit[]> => {
      if (!layer.url) {
        sources.push(unresolvedSource(layer));
        gaps.push(`Could not find the ${layer.label} layer, so that constraint is unknown.`);
        return [];
      }
      try {
        const info = await getLayerInfo(layer.url);
        const features = await queryLayer(layer.url, {
          intersects: geometry,
          returnGeometry: false,
          resultRecordCount: 10,
        });

        if (features.length === 0) {
          sources.push({ ...okSource(layer), status: "empty" });
          return [];
        }
        sources.push(okSource(layer));

        return features.map((feature) => {
          const overlayName = asString(readField(feature.properties, info.fields, "overlayName"));
          const floodZone = asString(readField(feature.properties, info.fields, "floodZone"));
          const named = overlayName ?? floodZone;
          return {
            ruleId: OVERLAY_LAYER_RULE_IDS[layer.key] ?? inferOverlayRuleId(named),
            // A bare FEMA zone code ("AE") means nothing to a reader, so give
            // it the layer's name and keep the code as a qualifier.
            name:
              overlayName === null && floodZone !== null
                ? `${layer.label} — zone ${floodZone}`
                : (named ?? layer.label),
            layerKey: layer.key,
          };
        });
      } catch (error) {
        sources.push(failedSource(layer, error));
        gaps.push(`Could not check the ${layer.label} layer, so that constraint is unknown.`);
        return [];
      }
    }),
  );

  const seen = new Set<string>();
  return results.flat().filter((hit) => {
    const key = `${hit.layerKey}:${hit.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Best-effort mapping from an overlay's printed name to a rule id. */
export function inferOverlayRuleId(name: string | null): string | null {
  if (!name) return null;
  const text = name.toUpperCase();
  if (text.includes("SHORELAND")) return "shoreland";
  if (text.includes("STREAM")) return "stream-protection";
  if (text.includes("COASTAL") || text.includes("BLUFF")) return "coastal-stability";
  if (text.includes("HISTORIC") || text.includes("LANDMARK")) return "historic-district";
  if (text.includes("AIRPORT") || text.includes("JETPORT") || text.includes("APPROACH")) {
    return "airport-approach";
  }
  if (text.includes("HEIGHT")) return "downtown-height";
  if (/^(A|AE|AO|AH|VE|V)$/.test(text) || text.includes("FLOOD")) return "flood-zone-ae";
  return null;
}

async function lookupStreets(
  centre: LonLat,
  sources: SourceRecord[],
  gaps: string[],
): Promise<LonLat[][]> {
  const layer = await locate("streets");
  if (!layer.url) {
    sources.push(unresolvedSource(layer));
    gaps.push(
      "No street centreline layer could be found, so the front lot line could not be identified.",
    );
    return [];
  }

  try {
    const features = await queryLayer(layer.url, {
      intersects: bufferBox(centre, 0.0018),
      resultRecordCount: 40,
    });
    if (features.length === 0) {
      sources.push({ ...okSource(layer), status: "empty" });
      gaps.push(
        "No street centreline was found near the parcel, so the front lot line could not be identified.",
      );
      return [];
    }
    sources.push(okSource(layer));
    return features.flatMap((feature) => toLineStrings(feature.geometry));
  } catch (error) {
    sources.push(failedSource(layer, error));
    gaps.push(
      "The street centreline layer was unreachable, so the front lot line could not be identified.",
    );
    return [];
  }
}

function toLineStrings(geometry: Geometry | null): LonLat[][] {
  if (!geometry) return [];
  if (geometry.type === "LineString") return [toLonLatPath(geometry.coordinates)];
  if (geometry.type === "MultiLineString") return geometry.coordinates.map(toLonLatPath);
  return [];
}

function toLonLatPath(positions: readonly number[][]): LonLat[] {
  return positions
    .filter((p): p is [number, number] => p.length >= 2)
    .map(([lon, lat]) => [lon, lat] as LonLat);
}

/** A small square around a point, in degrees, for "streets near here". */
function bufferBox([lon, lat]: LonLat, degrees: number): Polygon {
  return {
    type: "Polygon",
    coordinates: [
      [
        [lon - degrees, lat - degrees],
        [lon + degrees, lat - degrees],
        [lon + degrees, lat + degrees],
        [lon - degrees, lat + degrees],
        [lon - degrees, lat - degrees],
      ],
    ],
  };
}

function readRecordedArea(
  attributes: Record<string, unknown>,
  info: LayerInfo,
): number | null {
  const field = resolveField(info.fields, "lotAreaSf");
  if (!field) return null;
  const value = asNumber(attributes[field]);
  if (value === null) return null;
  // SHAPE_AREA is in the layer's own projected units, which we can't assume
  // are square feet. Only trust fields that name their units.
  if (/^SHAPE/i.test(field)) return null;
  return value;
}

function dedupeByGeometry(features: GisFeature[]): GisFeature[] {
  const seen = new Set<string>();
  return features.filter((feature) => {
    const key = JSON.stringify(feature.geometry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function okSource(layer: ResolvedLayer, detail?: string): SourceRecord {
  return {
    key: layer.key,
    label: layer.label,
    url: layer.url ?? "",
    status: "ok",
    via: layer.via,
    detail,
  };
}

function failedSource(layer: ResolvedLayer, error: unknown): SourceRecord {
  return {
    key: layer.key,
    label: layer.label,
    url: layer.url ?? "",
    status: "unavailable",
    via: layer.via,
    detail: error instanceof GisError ? error.message : String(error),
  };
}

function unresolvedSource(layer: ResolvedLayer): SourceRecord {
  return {
    key: layer.key,
    label: layer.label,
    url: "",
    status: "unavailable",
    via: layer.via,
    detail: `No endpoint resolved. Tried: ${layer.attempts
      .map((a) => `${a.url} (${a.outcome})`)
      .join(" | ")}`,
  };
}
