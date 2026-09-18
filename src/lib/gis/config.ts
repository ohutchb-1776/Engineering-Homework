/**
 * Where the app gets its geography.
 *
 * Every endpoint is overridable with an environment variable, because layer
 * numbering on a municipal ArcGIS server changes when the GIS team
 * republishes a service. `npm run gis:probe` prints what is actually live and
 * tells you which of these to change.
 */

const env = (key: string, fallback: string): string => {
  const value = process.env[key];
  return value && value.trim().length > 0 ? value.trim() : fallback;
};

/** Root of the City of Portland, Maine ArcGIS REST services directory. */
export const PORTLAND_GIS_ROOT = env(
  "PORTLAND_GIS_ROOT",
  "https://gis.portlandmaine.gov/maps/rest/services",
);

export interface LayerRef {
  /** Stable key used in code and in the probe output. */
  key: string;
  /** Human label used in the UI's source list. */
  label: string;
  url: string;
  /**
   * When false, the pipeline continues (with a recorded gap) if the layer is
   * unreachable. Only the parcel layer is genuinely required.
   */
  required: boolean;
}

export const LAYERS = {
  /** Assessor / development-review parcels: the spatial unit everything hangs off. */
  parcels: {
    key: "parcels",
    label: "City of Portland parcels",
    url: env("PORTLAND_PARCEL_LAYER", `${PORTLAND_GIS_ROOT}/Development_Review_Parcels/MapServer/0`),
    required: true,
  },
  /** Base zoning districts. */
  zoning: {
    key: "zoning",
    label: "City of Portland zoning districts",
    url: env("PORTLAND_ZONING_LAYER", `${PORTLAND_GIS_ROOT}/Zoning/MapServer/5`),
    required: true,
  },
  /** Catch-all overlay zone layer. */
  overlays: {
    key: "overlays",
    label: "City of Portland overlay zones",
    url: env("PORTLAND_OVERLAY_LAYER", `${PORTLAND_GIS_ROOT}/Zoning/MapServer/6`),
    required: false,
  },
  shoreland: {
    key: "shoreland",
    label: "Shoreland overlay zone",
    url: env("PORTLAND_SHORELAND_LAYER", `${PORTLAND_GIS_ROOT}/Zoning/MapServer/2`),
    required: false,
  },
  stream: {
    key: "stream",
    label: "Stream protection overlay",
    url: env("PORTLAND_STREAM_LAYER", `${PORTLAND_GIS_ROOT}/Zoning/MapServer/3`),
    required: false,
  },
  coastalStability: {
    key: "coastalStability",
    label: "Coastal stability / bluff overlay",
    url: env("PORTLAND_COASTAL_LAYER", `${PORTLAND_GIS_ROOT}/Zoning/MapServer/1`),
    required: false,
  },
  /** Street centrelines, used to work out which lot line is the frontage. */
  streets: {
    key: "streets",
    label: "Street centerlines",
    url: env("PORTLAND_STREETS_LAYER", `${PORTLAND_GIS_ROOT}/transportation/Streets/MapServer/0`),
    required: false,
  },
  /** Locally designated historic districts. */
  historic: {
    key: "historic",
    label: "Historic districts",
    url: env("PORTLAND_HISTORIC_LAYER", `${PORTLAND_GIS_ROOT}/Historic/MapServer/0`),
    required: false,
  },
  /** FEMA National Flood Hazard Layer, flood hazard areas (S_Fld_Haz_Ar). */
  flood: {
    key: "flood",
    label: "FEMA National Flood Hazard Layer",
    url: env(
      "FEMA_NFHL_LAYER",
      "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28",
    ),
    required: false,
  },
} as const satisfies Record<string, LayerRef>;

export type LayerKey = keyof typeof LAYERS;

/**
 * US Census Bureau geocoder. Free, keyless, and good enough to place an
 * address inside a parcel when the parcel layer's own address field misses.
 */
export const CENSUS_GEOCODER = env(
  "CENSUS_GEOCODER_URL",
  "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress",
);

/** Network timeout for a single upstream GIS request. */
export const GIS_TIMEOUT_MS = Number(env("GIS_TIMEOUT_MS", "12000"));

/** Portland's approximate bounding box, used to reject obviously wrong hits. */
export const PORTLAND_BBOX = {
  minLon: -70.35,
  minLat: 43.55,
  maxLon: -70.14,
  maxLat: 43.75,
} as const;
