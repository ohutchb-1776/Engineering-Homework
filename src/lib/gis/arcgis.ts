/**
 * A very small ArcGIS REST client.
 *
 * It does three things the rest of the app relies on: it reads a layer's own
 * metadata so we never have to guess field names, it normalises responses to
 * GeoJSON, and it fails loudly with a typed error instead of returning an
 * empty result that would silently become "no constraints found".
 */
import { arcgisToGeoJSON } from "@esri/arcgis-to-geojson-utils";
import type { Feature, Geometry } from "geojson";
import { GIS_TIMEOUT_MS } from "./config";

export class GisError extends Error {
  constructor(
    message: string,
    readonly layerUrl: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GisError";
  }
}

export interface LayerField {
  name: string;
  type: string;
  alias?: string;
}

export interface LayerInfo {
  url: string;
  name: string;
  geometryType?: string;
  fields: LayerField[];
}

export type GisFeature = Feature<Geometry, Record<string, unknown>>;

const layerInfoCache = new Map<string, Promise<LayerInfo>>();

export async function fetchArcgisJson(url: string, layerUrl: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GIS_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new GisError(`${response.status} ${response.statusText}`, layerUrl);
    }
    const body = (await response.json()) as unknown;
    // ArcGIS reports its own errors with HTTP 200 and an `error` member.
    if (body && typeof body === "object" && "error" in body) {
      const err = (body as { error: { message?: string; details?: string[] } }).error;
      throw new GisError(err.message ?? "ArcGIS returned an error", layerUrl, err);
    }
    return body;
  } catch (error) {
    if (error instanceof GisError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new GisError(`Timed out after ${GIS_TIMEOUT_MS}ms`, layerUrl, error);
    }
    throw new GisError(error instanceof Error ? error.message : "Request failed", layerUrl, error);
  } finally {
    clearTimeout(timer);
  }
}

/** Read and cache a layer's field list. One request per layer per process. */
export function getLayerInfo(layerUrl: string): Promise<LayerInfo> {
  const cached = layerInfoCache.get(layerUrl);
  if (cached) return cached;

  const pending = (async (): Promise<LayerInfo> => {
    const body = (await fetchArcgisJson(`${layerUrl}?f=json`, layerUrl)) as {
      name?: string;
      geometryType?: string;
      fields?: LayerField[];
    };
    return {
      url: layerUrl,
      name: body.name ?? layerUrl,
      geometryType: body.geometryType,
      fields: body.fields ?? [],
    };
  })();

  layerInfoCache.set(layerUrl, pending);
  pending.catch(() => layerInfoCache.delete(layerUrl));
  return pending;
}

export interface QueryOptions {
  where?: string;
  /** A GeoJSON point or polygon to intersect against. */
  intersects?: Geometry;
  outFields?: string;
  returnGeometry?: boolean;
  resultRecordCount?: number;
}

/** Run a query against one layer and return GeoJSON features in WGS84. */
export async function queryLayer(layerUrl: string, options: QueryOptions): Promise<GisFeature[]> {
  const params = new URLSearchParams({
    f: "json",
    outFields: options.outFields ?? "*",
    returnGeometry: String(options.returnGeometry ?? true),
    // Ask for WGS84 so results drop straight into GeoJSON and MapLibre.
    outSR: "4326",
    where: options.where ?? "1=1",
  });

  if (options.resultRecordCount) {
    params.set("resultRecordCount", String(options.resultRecordCount));
  }

  if (options.intersects) {
    const esri = geometryToEsri(options.intersects);
    params.set("geometry", JSON.stringify(esri.geometry));
    params.set("geometryType", esri.geometryType);
    params.set("inSR", "4326");
    params.set("spatialRel", "esriSpatialRelIntersects");
  }

  const body = (await fetchArcgisJson(`${layerUrl}/query?${params.toString()}`, layerUrl)) as {
    features?: { attributes?: Record<string, unknown>; geometry?: unknown }[];
  };

  return (body.features ?? []).map((feature) => ({
    type: "Feature" as const,
    properties: feature.attributes ?? {},
    geometry: feature.geometry
      ? (arcgisToGeoJSON({ ...(feature.geometry as object) }) as Geometry)
      : null,
  })) as GisFeature[];
}

function geometryToEsri(geometry: Geometry): { geometry: unknown; geometryType: string } {
  if (geometry.type === "Point") {
    const [x, y] = geometry.coordinates;
    return {
      geometry: { x, y, spatialReference: { wkid: 4326 } },
      geometryType: "esriGeometryPoint",
    };
  }
  if (geometry.type === "Polygon") {
    return {
      geometry: { rings: geometry.coordinates, spatialReference: { wkid: 4326 } },
      geometryType: "esriGeometryPolygon",
    };
  }
  if (geometry.type === "MultiPolygon") {
    return {
      geometry: { rings: geometry.coordinates.flat(), spatialReference: { wkid: 4326 } },
      geometryType: "esriGeometryPolygon",
    };
  }
  throw new Error(`Unsupported query geometry: ${geometry.type}`);
}

/** Escape a string for use inside a single-quoted ArcGIS SQL literal. */
export function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
