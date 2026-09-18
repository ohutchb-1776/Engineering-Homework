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
import { LAYERS, type LayerRef } from "./config";
import { GisError, getLayerInfo, queryLayer, sqlQuote, type GisFeature, type LayerInfo } from "./arcgis";
import { asNumber, asString, readField, resolveField } from "./fields";
import { geocodeAddress, inPortland } from "./geocode";
import { normalizeAddress } from "./address";
import type { LonLat } from "../geometry/project";

export interface SourceRecord {
  key: string;
  label: string;
  url: string;
  /** What we got: a hit, nothing there, or an outage. */
  status: "ok" | "empty" | "unavailable";
  detail?: string;
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
  };
  overlays: OverlayHit[];
  /** Street centrelines near the parcel, in WGS84, for frontage detection. */
  streetLines: LonLat[][];
  sources: SourceRecord[];
  /** Human-readable notes about what could not be determined. */
  gaps: string[];
  /** How the parcel was found. */
  matchMethod: "parcel-address-field" | "geocode-point-in-parcel";
  matchedAddress: string;
}

export class SiteLookupError extends Error {
  constructor(
    message: string,
    readonly kind: "not-found" | "ambiguous" | "upstream",
    readonly sources: SourceRecord[] = [],
    readonly candidates: string[] = [],
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

  const parcelInfo = await getLayerInfoOrThrow(LAYERS.parcels, sources);
  const { feature: parcelFeature, method } = await findParcel(normalized, parcelInfo, sources, gaps);

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
    lookupZoning(centre, sources, gaps),
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

async function getLayerInfoOrThrow(layer: LayerRef, sources: SourceRecord[]): Promise<LayerInfo> {
  try {
    const info = await getLayerInfo(layer.url);
    return info;
  } catch (error) {
    sources.push({
      key: layer.key,
      label: layer.label,
      url: layer.url,
      status: "unavailable",
      detail: error instanceof GisError ? error.message : String(error),
    });
    throw new SiteLookupError(
      `Could not reach the ${layer.label} layer, so no parcel could be identified.`,
      "upstream",
      sources,
    );
  }
}

async function findParcel(
  normalized: string,
  parcelInfo: LayerInfo,
  sources: SourceRecord[],
  gaps: string[],
): Promise<{
  feature: GisFeature;
  method: SiteData["matchMethod"];
}> {
  const addressField = resolveField(parcelInfo.fields, "address");

  if (addressField) {
    const where = `UPPER(${addressField}) LIKE ${sqlQuote(`${normalized}%`)}`;
    const matches = await queryLayer(LAYERS.parcels.url, { where, resultRecordCount: 25 });

    if (matches.length === 1) {
      sources.push(okSource(LAYERS.parcels, `matched on ${addressField}`));
      return { feature: matches[0]!, method: "parcel-address-field" };
    }
    if (matches.length > 1) {
      // Several records can share a street address (condominium units sharing
      // one lot). Identical geometry means it is really one parcel.
      const distinct = dedupeByGeometry(matches);
      if (distinct.length === 1) {
        sources.push(okSource(LAYERS.parcels, `matched on ${addressField}`));
        return { feature: distinct[0]!, method: "parcel-address-field" };
      }
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
  } else {
    gaps.push(
      "The parcel layer has no address field this app recognises, so the address was geocoded instead.",
    );
  }

  const hit = await geocodeAddress(normalized);
  if (!hit) {
    sources.push({ ...okSource(LAYERS.parcels), status: "empty" });
    throw new SiteLookupError(
      `No Portland parcel matched "${normalized}". Check the street number and spelling.`,
      "not-found",
      sources,
    );
  }
  if (!inPortland(hit.point)) {
    throw new SiteLookupError(
      "That address geocodes outside Portland, Maine. This tool only covers Portland.",
      "not-found",
      sources,
    );
  }

  const atPoint = await queryLayer(LAYERS.parcels.url, {
    intersects: { type: "Point", coordinates: [hit.point[0], hit.point[1]] },
    resultRecordCount: 5,
  });

  if (atPoint.length === 0) {
    sources.push({ ...okSource(LAYERS.parcels), status: "empty" });
    throw new SiteLookupError(
      `"${normalized}" geocoded successfully but falls outside every mapped Portland parcel.`,
      "not-found",
      sources,
    );
  }

  sources.push(okSource(LAYERS.parcels, `matched by point from the ${hit.source}`));
  return { feature: atPoint[0]!, method: "geocode-point-in-parcel" };
}

async function lookupZoning(
  centre: LonLat,
  sources: SourceRecord[],
  gaps: string[],
): Promise<SiteData["zoning"]> {
  try {
    const info = await getLayerInfo(LAYERS.zoning.url);
    const features = await queryLayer(LAYERS.zoning.url, {
      intersects: { type: "Point", coordinates: [centre[0], centre[1]] },
      returnGeometry: false,
      resultRecordCount: 5,
    });

    if (features.length === 0) {
      sources.push({ ...okSource(LAYERS.zoning), status: "empty" });
      gaps.push("No zoning district polygon covers this parcel's centre point.");
      return { districtCode: null, districtName: null, mappedMaxHeightFt: null };
    }

    const attributes = features[0]!.properties;
    sources.push(okSource(LAYERS.zoning));
    return {
      districtCode: asString(readField(attributes, info.fields, "zoningDistrict")),
      districtName: asString(readField(attributes, info.fields, "zoningName")),
      mappedMaxHeightFt: asNumber(readField(attributes, info.fields, "maxHeightFt")),
    };
  } catch (error) {
    sources.push(failedSource(LAYERS.zoning, error));
    gaps.push("The city zoning layer was unreachable, so the district could not be confirmed.");
    return { districtCode: null, districtName: null, mappedMaxHeightFt: null };
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
  const optional: LayerRef[] = [
    LAYERS.shoreland,
    LAYERS.stream,
    LAYERS.coastalStability,
    LAYERS.historic,
    LAYERS.overlays,
    LAYERS.flood,
  ];

  const results = await Promise.all(
    optional.map(async (layer): Promise<OverlayHit[]> => {
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
  try {
    const features = await queryLayer(LAYERS.streets.url, {
      intersects: bufferBox(centre, 0.0018),
      resultRecordCount: 40,
    });
    if (features.length === 0) {
      sources.push({ ...okSource(LAYERS.streets), status: "empty" });
      gaps.push(
        "No street centreline was found near the parcel, so the front lot line could not be identified.",
      );
      return [];
    }
    sources.push(okSource(LAYERS.streets));
    return features.flatMap((feature) => toLineStrings(feature.geometry));
  } catch (error) {
    sources.push(failedSource(LAYERS.streets, error));
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

function okSource(layer: LayerRef, detail?: string): SourceRecord {
  return { key: layer.key, label: layer.label, url: layer.url, status: "ok", detail };
}

function failedSource(layer: LayerRef, error: unknown): SourceRecord {
  return {
    key: layer.key,
    label: layer.label,
    url: layer.url,
    status: "unavailable",
    detail: error instanceof GisError ? error.message : String(error),
  };
}
