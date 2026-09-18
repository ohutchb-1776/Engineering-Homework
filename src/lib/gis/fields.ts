/**
 * Field-name tolerance.
 *
 * Municipal GIS layers name the same concept half a dozen ways
 * (`ADDRESS`, `SITE_ADDR`, `PROP_LOC`, `FULL_ADDR`…), and the names change
 * when a service is republished. Rather than hard-coding one guess, we read
 * the layer's field list and pick the first candidate that exists.
 */
import type { LayerField } from "./arcgis";

/** Candidate field names, most specific first, for each concept we need. */
export const FIELD_CANDIDATES = {
  address: [
    "FULL_ADDRESS",
    "SITE_ADDRESS",
    "SITE_ADDR",
    "PROP_LOC",
    "PROPERTY_ADDRESS",
    "STREET_ADDRESS",
    "LOCATION",
    "ADDRESS",
    "ADDR",
  ],
  parcelId: ["CBL", "PARCEL_ID", "PARCELID", "MAP_LOT", "MAPLOT", "PIN", "GPIN", "ACCOUNT"],
  zoningDistrict: [
    "ZONE_CODE",
    "ZONECODE",
    "ZONE_",
    "ZONING",
    "ZONE",
    "DISTRICT",
    "ZONE_ABBR",
    "ZONE_TYPE",
    "ZONE_CLASS",
  ],
  zoningName: ["ZONE_NAME", "ZONENAME", "DISTRICT_NAME", "NAME", "DESCRIPTION", "DESCRIPT"],
  overlayName: ["OVERLAY", "OVERLAY_NAME", "NAME", "ZONE", "TYPE", "DESCRIPTION", "LABEL"],
  /** Some cities publish the controlling height directly on the zoning layer. */
  maxHeightFt: ["MAX_HEIGHT", "MAXHEIGHT", "HEIGHT_LIMIT", "HEIGHT", "HT_LIMIT", "MAX_HT"],
  /** Assessor's own lot area, useful as a cross-check on computed area. */
  lotAreaSf: ["SHAPE_AREA", "AREA_SF", "LOT_SIZE", "LOTAREA", "LAND_SF", "SQFT", "SQ_FT"],
  landUse: ["LAND_USE", "LANDUSE", "USE_CODE", "PROPERTY_USE", "STATE_CLASS"],
  floodZone: ["FLD_ZONE", "ZONE_SUBTY", "FLOOD_ZONE", "SFHA_TF"],
  streetName: ["STREET_NAME", "STREETNAME", "FULL_NAME", "NAME", "ST_NAME", "STREET"],
} as const;

export type FieldConcept = keyof typeof FIELD_CANDIDATES;

/**
 * Find the layer's field for a concept, or null if the layer has none of the
 * names we know about. Matching is case-insensitive because ArcGIS layers are
 * inconsistent about it.
 */
export function resolveField(fields: readonly LayerField[], concept: FieldConcept): string | null {
  const byUpper = new Map(fields.map((f) => [f.name.toUpperCase(), f.name]));
  for (const candidate of FIELD_CANDIDATES[concept]) {
    const hit = byUpper.get(candidate);
    if (hit) return hit;
  }
  return null;
}

/** Read a concept's value straight off a feature's attributes. */
export function readField(
  attributes: Record<string, unknown>,
  fields: readonly LayerField[],
  concept: FieldConcept,
): unknown {
  const name = resolveField(fields, concept);
  return name ? attributes[name] : undefined;
}

export function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 && text.toLowerCase() !== "null" ? text : null;
}

export function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
