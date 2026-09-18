/**
 * A stand-in for an ArcGIS Server, good enough to exercise the real client.
 *
 * It speaks the parts of the REST API the app uses — layer metadata at
 * `/{layer}?f=json`, features at `/{layer}/query` — and returns Esri JSON, so
 * the field resolution, the SQL, the spatial filter and the Esri-to-GeoJSON
 * conversion all get tested rather than mocked away.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeLayer {
  name: string;
  geometryType: string;
  fields: { name: string; type: string }[];
  /** Esri-JSON features. */
  features: { attributes: Record<string, unknown>; geometry?: unknown }[];
  /** Force this layer to fail, to test the "unavailable" path. */
  fail?: number;
}

/** A MapServer/FeatureServer root that lists its layers. */
export interface FakeService {
  /** Layer index -> the key in the `layers` map that serves it. */
  layers: { id: number; name: string; serves: string }[];
  fail?: number;
}

export interface FakeArcgisOptions {
  /**
   * Stands in for the US Census geocoder at `/geocode`. Maps a normalised
   * address to a point, so the geocode fallback can be tested without leaving
   * the process.
   */
  geocoder?: Record<string, [number, number]>;
  /** Service roots, keyed by path segment. */
  services?: Record<string, FakeService>;
  /** ArcGIS Online items, keyed by item id. */
  agolItems?: Record<string, { url?: string; title?: string }>;
  /** ArcGIS Online web maps, keyed by item id. */
  agolWebMaps?: Record<string, { operationalLayers: { title: string; url?: string }[] }>;
}

export interface FakeArcgis {
  url: string;
  /** Every request path the client made, for asserting on the SQL it built. */
  requests: string[];
  close(): Promise<void>;
}

export async function startFakeArcgis(
  layers: Record<string, FakeLayer>,
  options: FakeArcgisOptions = {},
): Promise<FakeArcgis> {
  const requests: string[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push(url.pathname + url.search);
    res.setHeader("Content-Type", "application/json");

    // The Census geocoder stand-in.
    if (url.pathname === "/geocode") {
      const query = (url.searchParams.get("address") ?? "").toUpperCase();
      const entry = Object.entries(options.geocoder ?? {}).find(([key]) =>
        query.startsWith(key.toUpperCase()),
      );
      res.end(
        JSON.stringify({
          result: {
            addressMatches: entry
              ? [{ matchedAddress: entry[0], coordinates: { x: entry[1][0], y: entry[1][1] } }]
              : [],
          },
        }),
      );
      return;
    }

    // ArcGIS Online: web map data.
    const webMap = /^\/sharing\/rest\/content\/items\/(?<id>[^/]+)\/data$/.exec(url.pathname);
    if (webMap?.groups?.id) {
      const found = options.agolWebMaps?.[webMap.groups.id];
      if (!found) {
        res.end(JSON.stringify({ error: { message: "Item does not exist or is inaccessible." } }));
        return;
      }
      res.end(JSON.stringify(found));
      return;
    }

    // ArcGIS Online: item description.
    const item = /^\/sharing\/rest\/content\/items\/(?<id>[^/]+)$/.exec(url.pathname);
    if (item?.groups?.id) {
      const found = options.agolItems?.[item.groups.id];
      if (!found) {
        res.end(JSON.stringify({ error: { message: "Item does not exist or is inaccessible." } }));
        return;
      }
      res.end(JSON.stringify(found));
      return;
    }

    // A service root, e.g. /Zoning/MapServer
    const serviceMatch = /^\/(?<name>.+\/(?:Map|Feature)Server)$/.exec(url.pathname);
    const service = serviceMatch?.groups?.name
      ? options.services?.[serviceMatch.groups.name]
      : undefined;
    if (service) {
      if (service.fail) {
        res.statusCode = service.fail;
        res.end(JSON.stringify({ error: { message: "Service unavailable" } }));
        return;
      }
      res.end(
        JSON.stringify({ layers: service.layers.map(({ id, name }) => ({ id, name })) }),
      );
      return;
    }

    // A layer inside a service, e.g. /Zoning/MapServer/5 (+ /query)
    const inService = /^\/(?<name>.+\/(?:Map|Feature)Server)\/(?<id>\d+)(?<q>\/query)?$/.exec(
      url.pathname,
    );
    const serviceName = inService?.groups?.name;
    const layerIndex = inService?.groups?.id;
    if (serviceName !== undefined && layerIndex !== undefined) {
      const parent = options.services?.[serviceName];
      const entry = parent?.layers.find((l) => l.id === Number(layerIndex));
      if (entry) {
        serve(layers[entry.serves], inService?.groups?.q !== undefined, url, res);
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: "Layer not found" } }));
      return;
    }

    const queryMatch = /^\/(?<layer>[^/]+)\/query$/.exec(url.pathname);
    const infoMatch = /^\/(?<layer>[^/]+)$/.exec(url.pathname);
    const key = queryMatch?.groups?.layer ?? infoMatch?.groups?.layer;
    const layer = key ? layers[key] : undefined;

    serve(layer, !!queryMatch, url, res);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function serve(
  layer: FakeLayer | undefined,
  isQuery: boolean,
  url: URL,
  res: ServerResponse,
): void {
  if (!layer) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: "Layer not found" } }));
    return;
  }
  if (layer.fail) {
    res.statusCode = layer.fail;
    res.end(JSON.stringify({ error: { message: "Service unavailable" } }));
    return;
  }
  if (!isQuery) {
    res.end(
      JSON.stringify({ name: layer.name, geometryType: layer.geometryType, fields: layer.fields }),
    );
    return;
  }
  const where = url.searchParams.get("where") ?? "1=1";
  let features = layer.features.filter((f) => matchesWhere(f.attributes, where));

  const geometry = url.searchParams.get("geometry");
  if (geometry) {
    features = features.filter((f) => intersects(f.geometry, JSON.parse(geometry)));
  }
  res.end(JSON.stringify({ features }));
}

/**
 * A crude spatial filter: point-in-ring for a point query, bbox overlap for a
 * polygon query. Enough to tell "inside a parcel" from "near a parcel", which
 * is the distinction the app's fallback turns on.
 */
function intersects(geometry: unknown, filter: { x?: number; y?: number; rings?: number[][][] }): boolean {
  const rings = (geometry as { rings?: number[][][] } | undefined)?.rings;
  const paths = (geometry as { paths?: number[][][] } | undefined)?.paths;
  const coords = rings?.[0] ?? paths?.[0];
  if (!coords) return true;

  if (typeof filter.x === "number" && typeof filter.y === "number") {
    return rings ? pointInRing([filter.x, filter.y], coords) : true;
  }
  if (filter.rings) {
    return bboxOverlaps(coords, filter.rings.flat());
  }
  return true;
}

function pointInRing(point: number[], ring: number[][]): boolean {
  const [x, y] = point as [number, number];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function bboxOverlaps(a: number[][], b: number[][]): boolean {
  const box = (pts: number[][]) => ({
    minX: Math.min(...pts.map((p) => p[0]!)),
    maxX: Math.max(...pts.map((p) => p[0]!)),
    minY: Math.min(...pts.map((p) => p[1]!)),
    maxY: Math.max(...pts.map((p) => p[1]!)),
  });
  const A = box(a);
  const B = box(b);
  return A.minX <= B.maxX && A.maxX >= B.minX && A.minY <= B.maxY && A.maxY >= B.minY;
}

/**
 * Understands only `1=1` and the one shape the app builds:
 * `UPPER(FIELD) LIKE 'VALUE%'`. Anything else throws, so a change to the SQL
 * cannot silently pass the test.
 */
function matchesWhere(attributes: Record<string, unknown>, where: string): boolean {
  if (where === "1=1") return true;

  const like = /^UPPER\((?<field>\w+)\) LIKE '(?<value>.*)%'$/.exec(where);
  const field = like?.groups?.field;
  const value = like?.groups?.value;
  if (field === undefined || value === undefined) {
    throw new Error(`fake ArcGIS cannot parse WHERE clause: ${where}`);
  }

  const actual = String(attributes[field] ?? "").toUpperCase();
  return actual.startsWith(value.replace(/''/g, "'"));
}
