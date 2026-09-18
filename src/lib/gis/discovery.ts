/**
 * Finding a layer's real URL at run time.
 *
 * The app used to hardcode `.../Zoning/MapServer/5`. That works until the GIS
 * team republishes the service and layer 5 becomes layer 4, at which point
 * every answer quietly changes or the app dies. So instead of trusting a
 * number, this module asks the server what it has and matches by name, and
 * if the service itself has moved it falls back to the ArcGIS Online items
 * the city publishes — which are maintained by the city and therefore stay
 * correct on their own.
 *
 * Resolution order, first hit wins:
 *   1. the layer's environment variable, used verbatim
 *   2. each candidate service, searched by layer name
 *   3. ArcGIS Online web map operational layers
 *   4. ArcGIS Online items (e.g. the statewide parcel fallback)
 */
import {
  AGOL_SHARING,
  DISCOVERY_TTL_MS,
  LAYER_SPECS,
  PORTLAND_PARCEL_VIEWER_ITEM,
  type LayerSpec,
} from "./config";
import { fetchArcgisJson, getLayerInfo, GisError } from "./arcgis";

export interface ResolvedLayer {
  key: string;
  label: string;
  required: boolean;
  /** Null when nothing resolved. */
  url: string | null;
  /** How it was found, for /diagnostics and for the sources list. */
  via: "env" | "candidate" | "web-map" | "agol-item" | "unresolved";
  /** The layer's own name on the server, once known. */
  serverName?: string;
  /** Everything tried, and why each failed. Shown on /diagnostics. */
  attempts: { url: string; outcome: string }[];
}

interface CacheEntry {
  at: number;
  value: ResolvedLayer;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ResolvedLayer>>();

/** Drop every cached resolution. Used by /diagnostics and by the tests. */
export function resetDiscoveryCache(): void {
  cache.clear();
  inFlight.clear();
}

export function resolveLayer(spec: LayerSpec, force = false): Promise<ResolvedLayer> {
  if (!force) {
    const hit = cache.get(spec.key);
    // Only successful resolutions are cached; a failure is retried next time,
    // so a transient outage does not pin the app to "broken" for an hour.
    if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return Promise.resolve(hit.value);
    const pending = inFlight.get(spec.key);
    if (pending) return pending;
  }

  const promise = discover(spec).then((resolved) => {
    if (resolved.url) cache.set(spec.key, { at: Date.now(), value: resolved });
    inFlight.delete(spec.key);
    return resolved;
  });

  inFlight.set(spec.key, promise);
  return promise;
}

/** Resolve every layer at once, for the diagnostics page and the probe. */
export function resolveAllLayers(force = false): Promise<ResolvedLayer[]> {
  return Promise.all(LAYER_SPECS.map((spec) => resolveLayer(spec, force)));
}

async function discover(spec: LayerSpec): Promise<ResolvedLayer> {
  const attempts: ResolvedLayer["attempts"] = [];

  const override = process.env[spec.envVar]?.trim();
  if (override) {
    // An explicit override is an instruction, not a suggestion: it is used as
    // given so a misconfiguration is visible rather than silently routed past.
    return { ...base(spec), url: override, via: "env", attempts };
  }

  if (spec.preferWebMap) {
    const fromWebMap = await searchWebMap(PORTLAND_PARCEL_VIEWER_ITEM, spec, attempts);
    if (fromWebMap) {
      return { ...base(spec), url: fromWebMap.url, via: "web-map", serverName: fromWebMap.name, attempts };
    }
  }

  for (const candidate of dedupe(spec.candidates)) {
    const found = await searchService(candidate, spec, attempts);
    if (found) {
      return { ...base(spec), url: found.url, via: "candidate", serverName: found.name, attempts };
    }
  }

  if (!spec.preferWebMap) {
    const fromWebMap = await searchWebMap(PORTLAND_PARCEL_VIEWER_ITEM, spec, attempts);
    if (fromWebMap) {
      return { ...base(spec), url: fromWebMap.url, via: "web-map", serverName: fromWebMap.name, attempts };
    }
  }

  for (const item of spec.agolItems ?? []) {
    const fromItem = await searchAgolItem(item, spec, attempts);
    if (fromItem) {
      return { ...base(spec), url: fromItem.url, via: "agol-item", serverName: fromItem.name, attempts };
    }
  }

  return { ...base(spec), url: null, via: "unresolved", attempts };
}

function base(spec: LayerSpec) {
  return { key: spec.key, label: spec.label, required: spec.required };
}

interface Hit {
  url: string;
  name: string;
}

/**
 * Look inside one service. The URL may already point at a layer (it ends in a
 * number and exposes `fields`), or at a service whose `layers` we search.
 */
async function searchService(
  url: string,
  spec: LayerSpec,
  attempts: ResolvedLayer["attempts"],
): Promise<Hit | null> {
  try {
    const body = (await fetchArcgisJson(`${url}?f=json`, url)) as {
      name?: string;
      fields?: unknown[];
      layers?: { id: number; name: string }[];
    };

    // Already a layer.
    if (Array.isArray(body.fields) && body.fields.length > 0) {
      const geometry = (body as { geometryType?: string }).geometryType;
      if (spec.requireGeometry && geometry !== spec.requireGeometry) {
        attempts.push({
          url,
          outcome: `layer "${body.name ?? "?"}" is ${geometry ?? "not spatial"}, need ${spec.requireGeometry}`,
        });
        return null;
      }
      attempts.push({ url, outcome: `ok — layer "${body.name ?? "?"}"` });
      return { url, name: body.name ?? spec.key };
    }

    const layers = body.layers ?? [];
    if (layers.length === 0) {
      attempts.push({ url, outcome: "reachable, but publishes no layers" });
      return null;
    }

    // Several layers may match by name; take the first whose geometry is
    // right. "Parcels" (polygons) and "Parcel Labels" (points) both contain
    // "parcel", and only one of them can answer "which lot is this point in".
    const ranked = rankLayersByName(layers, spec.layerNames, spec.excludeNames);
    for (const matched of ranked) {
      const layerUrl = `${url}/${matched.id}`;
      const geometryProblem = await geometryMismatch(layerUrl, spec);
      if (geometryProblem) {
        attempts.push({ url: layerUrl, outcome: `"${matched.name}" ${geometryProblem}` });
        continue;
      }
      attempts.push({ url, outcome: `ok — matched "${matched.name}" at index ${matched.id}` });
      return { url: layerUrl, name: matched.name };
    }

    if (spec.fallbackIndex !== undefined) {
      const byIndex = layers.find((l) => l.id === spec.fallbackIndex);
      if (byIndex) {
        const layerUrl = `${url}/${byIndex.id}`;
        const geometryProblem = await geometryMismatch(layerUrl, spec);
        if (geometryProblem) {
          attempts.push({ url: layerUrl, outcome: `fallback index ${byIndex.id} ${geometryProblem}` });
          return null;
        }
        attempts.push({
          url,
          outcome: `no name matched; fell back to index ${spec.fallbackIndex} ("${byIndex.name}")`,
        });
        return { url: layerUrl, name: byIndex.name };
      }
    }

    attempts.push({
      url,
      outcome: `no layer matched ${spec.layerNames.join(" / ")} — has: ${layers
        .map((l) => l.name)
        .join(", ")}`,
    });
    return null;
  } catch (error) {
    attempts.push({ url, outcome: error instanceof GisError ? error.message : String(error) });
    return null;
  }
}

/**
 * "" when the layer's geometry is acceptable, otherwise a short reason.
 * Costs one request, which is cheap next to answering the wrong question.
 */
async function geometryMismatch(layerUrl: string, spec: LayerSpec): Promise<string> {
  if (!spec.requireGeometry) return "";
  try {
    const info = await getLayerInfo(layerUrl);
    if (info.geometryType === spec.requireGeometry) return "";
    return `is ${info.geometryType ?? "not spatial"}, need ${spec.requireGeometry}`;
  } catch (error) {
    return `could not be read: ${error instanceof GisError ? error.message : String(error)}`;
  }
}

/**
 * Every layer that matches, best first. Exact matches on earlier names rank
 * above partial matches on later ones.
 */
export function rankLayersByName<T extends { id: number; name: string }>(
  layers: readonly T[],
  wanted: readonly string[],
  excluded: readonly string[] = [],
): T[] {
  const allowed = layers.filter((layer) => {
    const name = layer.name.toLowerCase();
    return !excluded.some((bad) => name.includes(bad.toLowerCase()));
  });
  const out: T[] = [];
  const push = (layer: T) => {
    if (!out.includes(layer)) out.push(layer);
  };
  for (const want of wanted) {
    const needle = want.toLowerCase();
    allowed.filter((l) => l.name.toLowerCase() === needle).forEach(push);
  }
  for (const want of wanted) {
    const needle = want.toLowerCase();
    allowed.filter((l) => l.name.toLowerCase().includes(needle)).forEach(push);
  }
  return out;
}

/**
 * Pick the best-matching layer, preferring earlier names in the list.
 *
 * `excluded` exists because these names overlap: "Shoreland Overlay Zone"
 * contains "overlay zone", so without it the generic overlay layer would
 * happily resolve to the shoreland layer and every parcel near the water
 * would get its constraints counted twice while the real overlay layer was
 * never read at all.
 */
export function matchLayerByName<T extends { id: number; name: string }>(
  layers: readonly T[],
  wanted: readonly string[],
  excluded: readonly string[] = [],
): T | null {
  const allowed = layers.filter((layer) => {
    const name = layer.name.toLowerCase();
    return !excluded.some((bad) => name.includes(bad.toLowerCase()));
  });

  for (const want of wanted) {
    const needle = want.toLowerCase();
    const exact = allowed.find((l) => l.name.toLowerCase() === needle);
    if (exact) return exact;
    const partial = allowed.find((l) => l.name.toLowerCase().includes(needle));
    if (partial) return partial;
  }
  return null;
}

/**
 * Read the operational layers out of an ArcGIS Online web map. This is how the
 * city itself says where its data lives, so it survives a service being
 * renamed or moved to a different host entirely.
 */
async function searchWebMap(
  itemId: string,
  spec: LayerSpec,
  attempts: ResolvedLayer["attempts"],
): Promise<Hit | null> {
  const url = `${AGOL_SHARING}/content/items/${itemId}/data?f=json`;
  try {
    const body = (await fetchArcgisJson(url, url)) as {
      operationalLayers?: WebMapLayer[];
    };
    const flat = flattenWebMapLayers(body.operationalLayers ?? []);
    if (flat.length === 0) {
      attempts.push({ url, outcome: "web map has no operational layers" });
      return null;
    }

    const allowed = flat.filter(
      (l) => !(spec.excludeNames ?? []).some((bad) => l.title.toLowerCase().includes(bad.toLowerCase())),
    );
    for (const want of spec.layerNames) {
      const needle = want.toLowerCase();
      const hit =
        allowed.find((l) => l.title.toLowerCase() === needle) ??
        allowed.find((l) => l.title.toLowerCase().includes(needle));
      if (hit?.url) {
        const target = /\/\d+$/.test(hit.url) ? hit.url : null;
        if (!target) {
          // A service root rather than a layer: search inside it.
          const inside = await searchService(hit.url, spec, attempts);
          if (inside) return inside;
          continue;
        }
        const geometryProblem = await geometryMismatch(target, spec);
        if (geometryProblem) {
          attempts.push({ url: target, outcome: `web map layer "${hit.title}" ${geometryProblem}` });
          continue;
        }
        attempts.push({ url, outcome: `ok — web map layer "${hit.title}"` });
        return { url: target, name: hit.title };
      }
    }

    attempts.push({
      url,
      outcome: `no web map layer matched — has: ${flat.map((l) => l.title).join(", ")}`,
    });
    return null;
  } catch (error) {
    attempts.push({ url, outcome: error instanceof GisError ? error.message : String(error) });
    return null;
  }
}

interface WebMapLayer {
  title?: string;
  url?: string;
  layers?: WebMapLayer[];
}

/** Web maps nest group layers, so flatten before matching. */
function flattenWebMapLayers(layers: readonly WebMapLayer[]): { title: string; url?: string }[] {
  const out: { title: string; url?: string }[] = [];
  for (const layer of layers) {
    if (layer.title) out.push({ title: layer.title, url: layer.url });
    if (layer.layers) out.push(...flattenWebMapLayers(layer.layers));
  }
  return out;
}

/** Resolve an ArcGIS Online item id to the service URL it points at. */
async function searchAgolItem(
  itemId: string,
  spec: LayerSpec,
  attempts: ResolvedLayer["attempts"],
): Promise<Hit | null> {
  const url = `${AGOL_SHARING}/content/items/${itemId}?f=json`;
  try {
    const body = (await fetchArcgisJson(url, url)) as { url?: string; title?: string };
    if (!body.url) {
      attempts.push({ url, outcome: "item has no service url" });
      return null;
    }
    const hit = await searchService(body.url, spec, attempts);
    if (hit) return hit;
    // Some items point straight at a single layer.
    try {
      const info = await getLayerInfo(body.url);
      if (info.fields.length > 0) return { url: body.url, name: info.name };
    } catch {
      // Already recorded by searchService.
    }
    return null;
  } catch (error) {
    attempts.push({ url, outcome: error instanceof GisError ? error.message : String(error) });
    return null;
  }
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
