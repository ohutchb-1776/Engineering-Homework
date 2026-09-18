/**
 * A stand-in for an ArcGIS Server, good enough to exercise the real client.
 *
 * It speaks the parts of the REST API the app uses — layer metadata at
 * `/{layer}?f=json`, features at `/{layer}/query` — and returns Esri JSON, so
 * the field resolution, the SQL, the spatial filter and the Esri-to-GeoJSON
 * conversion all get tested rather than mocked away.
 */
import { createServer, type Server } from "node:http";
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

export interface FakeArcgis {
  url: string;
  /** Every request path the client made, for asserting on the SQL it built. */
  requests: string[];
  close(): Promise<void>;
}

export async function startFakeArcgis(layers: Record<string, FakeLayer>): Promise<FakeArcgis> {
  const requests: string[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push(url.pathname + url.search);

    const queryMatch = /^\/(?<layer>[^/]+)\/query$/.exec(url.pathname);
    const infoMatch = /^\/(?<layer>[^/]+)$/.exec(url.pathname);
    const key = queryMatch?.groups?.layer ?? infoMatch?.groups?.layer;
    const layer = key ? layers[key] : undefined;

    res.setHeader("Content-Type", "application/json");

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

    if (infoMatch) {
      res.end(
        JSON.stringify({ name: layer.name, geometryType: layer.geometryType, fields: layer.fields }),
      );
      return;
    }

    const where = url.searchParams.get("where") ?? "1=1";
    const features = layer.features.filter((f) => matchesWhere(f.attributes, where));
    res.end(JSON.stringify({ features }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
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
