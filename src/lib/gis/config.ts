/**
 * Where the app looks for its geography.
 *
 * Municipal ArcGIS services move: layer numbers shift when a service is
 * republished, and service names change with them. Hardcoding one URL per
 * layer means the app breaks silently months later, so instead each layer
 * declares *how to find itself*: an environment override, then a list of
 * candidate services, then ArcGIS Online items the city publishes. The first
 * one that resolves wins, and the resolution is reported on /diagnostics.
 */

const env = (key: string): string | null => {
  const value = process.env[key];
  return value && value.trim().length > 0 ? value.trim() : null;
};

/** Root of the City of Portland, Maine ArcGIS REST services directory. */
export const PORTLAND_GIS_ROOT =
  env("PORTLAND_GIS_ROOT") ?? "https://gis.portlandmaine.gov/maps/rest/services";

/** The same server has been published under both of these paths over time. */
const PORTLAND_ROOTS = [
  PORTLAND_GIS_ROOT,
  "https://gis.portlandmaine.gov/maps/rest/services",
  "https://gis.portlandmaine.gov/arcgis/rest/services",
];

/**
 * The city's public Parcel Viewer. Its web map lists the service URLs the city
 * is actually serving today, which makes it a self-updating source of truth
 * when the hardcoded candidates below go stale.
 */
export const PORTLAND_PARCEL_VIEWER_ITEM =
  env("PORTLAND_AGOL_WEBMAP_ITEM") ?? "6208128831ea40c7a7c432317527336b";

/**
 * Maine GeoLibrary's statewide parcel layer, used only if every Portland
 * parcel candidate fails. It is hosted on ArcGIS Online rather than the city's
 * own server, so it stays up when the city's does not. It carries no zoning.
 */
export const MAINE_STATEWIDE_PARCELS_ITEM =
  env("MAINE_PARCELS_AGOL_ITEM") ?? "346131b710a645ffb624f448a9cba6d4";

/** How to find one layer. */
export interface LayerSpec {
  /** Stable key used in code, in the probe and on /diagnostics. */
  key: string;
  /** Human label used in the UI's source list. */
  label: string;
  /**
   * When false, the pipeline continues (with a recorded gap) if the layer
   * cannot be found. Only the parcel layer is genuinely required.
   */
  required: boolean;
  /** Environment variable that pins this layer to an exact URL. */
  envVar: string;
  /**
   * Services to search, in order. Each may be a MapServer/FeatureServer root
   * (whose layers are searched by name) or a layer URL ending in an index.
   */
  candidates: string[];
  /**
   * Layer names to match inside a service, lowercase, matched as substrings
   * in order of preference.
   */
  layerNames: string[];
  /**
   * Layer names that must NOT match, lowercase substrings. Needed because
   * "Shoreland Overlay Zone" contains both "shoreland" and "overlay zone".
   */
  excludeNames?: string[];
  /** Layer index to use if no name matches. Omit to fail instead of guessing. */
  fallbackIndex?: number;
  /** ArcGIS Online item ids to fall back to, in order. */
  agolItems?: string[];
  /**
   * The geometry the layer must have. A layer called "Parcel Labels" or
   * "Development Review Parcels" can match by name and still be points, or a
   * subset — this rejects the first kind outright.
   */
  requireGeometry?: "esriGeometryPolygon" | "esriGeometryPolyline" | "esriGeometryPoint";
  /**
   * Consult the city's published web map BEFORE the candidate list. For the
   * parcel layer this matters: the Parcel Viewer is by definition the city's
   * complete parcel fabric, whereas a candidate named "Development_Review_
   * Parcels" resolves happily and is only the parcels under review.
   */
  preferWebMap?: boolean;
}

const portland = (service: string): string[] =>
  PORTLAND_ROOTS.map((root) => `${root}/${service}`);

export const LAYER_SPECS: LayerSpec[] = [
  {
    key: "parcels",
    label: "City of Portland parcels",
    required: true,
    envVar: "PORTLAND_PARCEL_LAYER",
    preferWebMap: true,
    requireGeometry: "esriGeometryPolygon",
    candidates: [
      ...portland("Parcels/MapServer"),
      ...portland("Parcels/FeatureServer"),
      ...portland("Assessing/MapServer"),
      ...portland("Assessor/MapServer"),
      ...portland("Property/MapServer"),
      ...portland("Cadastral/MapServer"),
      ...portland("Basemap/MapServer"),
      ...portland("Base/MapServer"),
      // Last, on purpose: this is the parcels under development review, which
      // is a subset. It is better than nothing and worse than anything else.
      ...portland("Development_Review_Parcels/MapServer"),
      ...portland("Development_Review_Parcels/FeatureServer"),
    ],
    // "tax parcel" and "parcels" before "parcel", so a layer literally named
    // "Parcels" beats "Parcel Labels" or "Parcel Lines".
    layerNames: ["tax parcels", "tax parcel", "parcels", "parcel boundaries", "parcel", "property", "lots"],
    excludeNames: ["label", "line", "annotation", "point", "review", "history", "historic", "retired"],
    agolItems: [MAINE_STATEWIDE_PARCELS_ITEM],
  },
  {
    /**
     * The city's own address points (E911 / master address). A point placed
     * on the building is a far better way to find a lot than a national
     * geocoder that interpolates along the street, and it is what makes an
     * address on a square resolve at all.
     */
    key: "addressPoints",
    label: "City of Portland address points",
    required: false,
    envVar: "PORTLAND_ADDRESS_POINTS_LAYER",
    requireGeometry: "esriGeometryPoint",
    candidates: [
      ...portland("Addresses/MapServer"),
      ...portland("Address_Points/MapServer"),
      ...portland("AddressPoints/MapServer"),
      ...portland("E911/MapServer"),
      ...portland("E911_Addresses/MapServer"),
      ...portland("Basemap/MapServer"),
    ],
    layerNames: ["address point", "address points", "addresses", "e911", "site address", "address"],
    excludeNames: ["range", "label", "annotation"],
  },
  {
    key: "zoning",
    label: "City of Portland zoning districts",
    required: true,
    envVar: "PORTLAND_ZONING_LAYER",
    requireGeometry: "esriGeometryPolygon",
    candidates: [
      ...portland("Zoning/MapServer"),
      ...portland("Zoning/FeatureServer"),
      ...portland("Zoning_Map_2026_05_01/MapServer"),
      ...portland("Zoning_Map_2026_05_01/FeatureServer"),
    ],
    // "zoning" alone would also match "shoreland overlay zone", so the more
    // specific names come first and the overlay layers are excluded outright.
    layerNames: ["base zoning", "zoning district", "zoning"],
    excludeNames: ["overlay", "shoreland", "stream", "coastal", "historic", "line"],
  },
  {
    key: "overlays",
    label: "City of Portland overlay zones",
    required: false,
    envVar: "PORTLAND_OVERLAY_LAYER",
    candidates: [...portland("Zoning/MapServer"), ...portland("Zoning/FeatureServer")],
    layerNames: ["overlay zones", "overlay zone", "overlay"],
    // Each of these has its own spec; the generic layer must not steal them.
    excludeNames: ["shoreland", "stream", "coastal", "historic"],
  },
  {
    key: "shoreland",
    label: "Shoreland overlay zone",
    required: false,
    envVar: "PORTLAND_SHORELAND_LAYER",
    candidates: [...portland("Zoning/MapServer"), ...portland("Zoning/FeatureServer")],
    layerNames: ["shoreland"],
  },
  {
    key: "stream",
    label: "Stream protection overlay",
    required: false,
    envVar: "PORTLAND_STREAM_LAYER",
    candidates: [...portland("Zoning/MapServer"), ...portland("Zoning/FeatureServer")],
    layerNames: ["stream"],
  },
  {
    key: "coastalStability",
    label: "Coastal stability / bluff overlay",
    required: false,
    envVar: "PORTLAND_COASTAL_LAYER",
    candidates: [...portland("Zoning/MapServer"), ...portland("Zoning/FeatureServer")],
    layerNames: ["coastal stability", "coastal", "bluff"],
  },
  {
    key: "streets",
    label: "Street centerlines",
    required: false,
    envVar: "PORTLAND_STREETS_LAYER",
    requireGeometry: "esriGeometryPolyline",
    candidates: [
      ...portland("transportation/Streets/MapServer"),
      ...portland("Streets/MapServer"),
      ...portland("transportation/Transportation/MapServer"),
    ],
    layerNames: ["street centerline", "centerline", "street", "road"],
  },
  {
    key: "historic",
    label: "Historic districts",
    required: false,
    envVar: "PORTLAND_HISTORIC_LAYER",
    candidates: [
      ...portland("Historic/MapServer"),
      ...portland("HistoricPreservation/MapServer"),
      ...portland("Planning/MapServer"),
    ],
    layerNames: ["historic district", "historic", "landmark"],
  },
  {
    key: "flood",
    label: "FEMA National Flood Hazard Layer",
    required: false,
    envVar: "FEMA_NFHL_LAYER",
    candidates: ["https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer"],
    layerNames: ["flood hazard zones", "flood hazard areas", "flood hazard", "s_fld_haz_ar"],
    fallbackIndex: 28,
  },
];

export const LAYER_SPEC_BY_KEY: Record<string, LayerSpec> = Object.fromEntries(
  LAYER_SPECS.map((spec) => [spec.key, spec]),
);

export type LayerKey = (typeof LAYER_SPECS)[number]["key"];

/** ArcGIS Online sharing API, used to resolve item and web map URLs. */
export const AGOL_SHARING =
  env("AGOL_SHARING_URL") ?? "https://www.arcgis.com/sharing/rest";

/**
 * US Census Bureau geocoder. Free, keyless, and good enough to place an
 * address inside a parcel when the parcel layer's own address field misses.
 */
export const CENSUS_GEOCODER =
  env("CENSUS_GEOCODER_URL") ??
  "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

/** Network timeout for a single upstream GIS request. */
export const GIS_TIMEOUT_MS = Number(env("GIS_TIMEOUT_MS") ?? "12000");

/** How long a successful endpoint resolution is reused, in milliseconds. */
export const DISCOVERY_TTL_MS = Number(env("GIS_DISCOVERY_TTL_MS") ?? String(60 * 60 * 1000));

/** Portland's approximate bounding box, used to reject obviously wrong hits. */
export const PORTLAND_BBOX = {
  minLon: -70.35,
  minLat: 43.55,
  maxLon: -70.14,
  maxLat: 43.75,
} as const;
