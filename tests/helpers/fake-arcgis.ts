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
  const features = layer.features.filter((f) => matchesWhere(f.attributes, where));
  res.end(JSON.stringify({ features }));
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
