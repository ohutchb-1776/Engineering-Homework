/**
 * Endpoint discovery.
 *
 * The point of this module is that the app keeps working when the city
 * republishes a service and every layer number shifts. These tests make that
 * concrete: the same fake server is served under different layer orderings and
 * different service names, and the app is expected to find its way regardless.
 */
import { strict as assert } from "node:assert";
import { after, before, beforeEach, describe, it } from "node:test";
import { startFakeArcgis, type FakeArcgis, type FakeLayer } from "./helpers/fake-arcgis";

// config.ts reads the environment the first time it is imported, and the fake
// server's port is not known until it is listening — so nothing under src/ may
// be imported statically here.

const layer = (name: string, field: string): FakeLayer => ({
  name,
  geometryType: "esriGeometryPolygon",
  fields: [{ name: field, type: "esriFieldTypeString" }],
  features: [],
});

let server: FakeArcgis;
type Discovery = typeof import("../src/lib/gis/discovery");
type Config = typeof import("../src/lib/gis/config");
let discovery: Discovery;
let config: Config;

const agolItems: Record<string, { url?: string; title?: string }> = {
  "statewide-item": { title: "Maine Parcels" },
};
const agolWebMaps: Record<string, { operationalLayers: { title: string; url?: string }[] }> = {
  "city-webmap": {
    operationalLayers: [
      { title: "Basemap" },
      { title: "Base Zoning Districts" },
      { title: "Tax Parcels" },
    ],
  },
};

before(async () => {
  server = await startFakeArcgis(
    {
      parcels: layer("Parcels", "PROP_LOC"),
      parcelLabels: { ...layer("Parcel Labels", "LABEL"), geometryType: "esriGeometryPoint" },
      reviewParcels: layer("Development Review Parcels", "PROP_LOC"),
      viewerParcels: layer("Tax Parcels", "PROP_LOC"),
      zoning: layer("Base Zoning Districts", "ZONE_"),
      shoreland: layer("Shoreland Overlay Zone", "NAME"),
      statewide: layer("Maine Parcels", "PROP_LOC"),
      movedZoning: layer("Base Zoning Districts", "ZONE_"),
    },
    {
      services: {
        // Deliberately not in a tidy order, and zoning is NOT at index 5.
        "Zoning/MapServer": {
          layers: [
            { id: 0, name: "Shoreland Overlay Zone", serves: "shoreland" },
            { id: 1, name: "Base Zoning Districts", serves: "zoning" },
          ],
        },
        "Development_Review_Parcels/MapServer": {
          // Labels are points and come first; the polygon layer must win.
          layers: [
            { id: 0, name: "Parcel Labels", serves: "parcelLabels" },
            { id: 1, name: "Parcels", serves: "parcels" },
          ],
        },
        "ParcelViewer/MapServer": {
          layers: [{ id: 4, name: "Tax Parcels", serves: "viewerParcels" }],
        },
        // A service that exists but is broken, to prove we move past it.
        "Parcels/MapServer": { layers: [], fail: 503 },
        "Statewide/MapServer": {
          layers: [{ id: 0, name: "Maine Parcels", serves: "statewide" }],
        },
        // Where the city "moved" zoning to; only the web map knows about it.
        "Zoning_2027/MapServer": {
          layers: [{ id: 3, name: "Base Zoning Districts", serves: "movedZoning" }],
        },
      },
      agolItems,
      agolWebMaps,
    },
  );

  // The handler reads these objects per request, so filling in the port after
  // the server is listening is enough.
  agolItems["statewide-item"]!.url = `${server.url}/Statewide/MapServer`;
  agolWebMaps["city-webmap"]!.operationalLayers[1]!.url = `${server.url}/Zoning_2027/MapServer/3`;
  agolWebMaps["city-webmap"]!.operationalLayers[2]!.url = `${server.url}/ParcelViewer/MapServer/4`;

  process.env.AGOL_SHARING_URL = `${server.url}/sharing/rest`;
  process.env.PORTLAND_GIS_ROOT = server.url;
  process.env.PORTLAND_AGOL_WEBMAP_ITEM = "city-webmap";
  process.env.MAINE_PARCELS_AGOL_ITEM = "statewide-item";
  process.env.GIS_DISCOVERY_TTL_MS = "60000";

  config = await import("../src/lib/gis/config");
  discovery = await import("../src/lib/gis/discovery");
});

beforeEach(() => {
  discovery.resetDiscoveryCache();
});

after(async () => {
  await server.close();
});

describe("matchLayerByName", () => {
  const layers = [
    { id: 0, name: "Shoreland Overlay Zone" },
    { id: 1, name: "Base Zoning Districts" },
    { id: 2, name: "Zoning" },
  ];

  it("prefers an exact match over a substring", () => {
    assert.equal(discovery.matchLayerByName(layers, ["zoning"])?.id, 2);
  });

  it("honours the caller's order of preference", () => {
    // "base zoning" is listed first, so it wins even though "zoning" also matches.
    assert.equal(discovery.matchLayerByName(layers, ["base zoning", "zoning"])?.id, 1);
  });

  it("does not confuse an overlay for the base district", () => {
    assert.equal(discovery.matchLayerByName(layers, ["shoreland"])?.id, 0);
  });

  it("returns null rather than the first layer when nothing matches", () => {
    assert.equal(discovery.matchLayerByName(layers, ["parcels"]), null);
  });
});

describe("resolveLayer", () => {
  it("finds a layer by name rather than by a hardcoded index", async () => {
    const resolved = await discovery.resolveLayer(config.LAYER_SPEC_BY_KEY.zoning!);
    // Zoning is at index 1 here, not the 5 the app once hardcoded.
    assert.equal(resolved.url, `${server.url}/Zoning/MapServer/1`);
    assert.equal(resolved.via, "candidate");
    assert.equal(resolved.serverName, "Base Zoning Districts");
  });

  it("distinguishes the overlay from the base district in the same service", async () => {
    const resolved = await discovery.resolveLayer(config.LAYER_SPEC_BY_KEY.shoreland!);
    assert.equal(resolved.url, `${server.url}/Zoning/MapServer/0`);
  });

  it("prefers the city's Parcel Viewer web map for parcels over any candidate", async () => {
    const resolved = await discovery.resolveLayer(config.LAYER_SPEC_BY_KEY.parcels!);
    assert.equal(resolved.via, "web-map");
    assert.equal(resolved.url, `${server.url}/ParcelViewer/MapServer/4`);
  });

  it("moves past a service that is down and uses the next candidate", async () => {
    const resolved = await discovery.resolveLayer({
      ...config.LAYER_SPEC_BY_KEY.parcels!,
      key: "parcels-no-webmap",
      preferWebMap: false,
      layerNames: ["parcels", "parcel"],
      agolItems: [],
    });
    assert.equal(resolved.via, "candidate");
    assert.equal(resolved.url, `${server.url}/Development_Review_Parcels/MapServer/1`);
    assert.ok(resolved.attempts.some((a) => a.url.includes("Parcels/MapServer")));
  });

  it("rejects a name match with the wrong geometry and keeps looking", async () => {
    const resolved = await discovery.resolveLayer({
      key: "parcels-geometry",
      label: "x",
      required: true,
      envVar: "UNUSED",
      candidates: [`${server.url}/Development_Review_Parcels/MapServer`],
      layerNames: ["parcel"],
      requireGeometry: "esriGeometryPolygon",
    });
    // "Parcel Labels" (index 0) matches first by name but is points.
    assert.equal(resolved.url, `${server.url}/Development_Review_Parcels/MapServer/1`);
    assert.ok(
      resolved.attempts.some((a) => /Parcel Labels.*esriGeometryPoint/.test(a.outcome)),
      "the rejected layer must be recorded with the reason",
    );
  });

  it("records every endpoint it tried, so a failure can be diagnosed", async () => {
    const resolved = await discovery.resolveLayer(config.LAYER_SPEC_BY_KEY.historic!);
    assert.equal(resolved.url, null);
    assert.equal(resolved.via, "unresolved");
    assert.ok(resolved.attempts.length > 0, "an unresolved layer must say what it tried");
    for (const attempt of resolved.attempts) {
      assert.ok(attempt.url.length > 0);
      assert.ok(attempt.outcome.length > 0);
    }
  });

  it("uses an environment override verbatim, without probing", async () => {
    process.env.PORTLAND_ZONING_LAYER = "https://example.test/Zoning/MapServer/9";
    try {
      const resolved = await discovery.resolveLayer(config.LAYER_SPEC_BY_KEY.zoning!, true);
      assert.equal(resolved.url, "https://example.test/Zoning/MapServer/9");
      assert.equal(resolved.via, "env");
      assert.equal(resolved.attempts.length, 0, "an override must not probe the network");
    } finally {
      delete process.env.PORTLAND_ZONING_LAYER;
    }
  });

  it("caches a success but retries a failure", async () => {
    await discovery.resolveLayer(config.LAYER_SPEC_BY_KEY.zoning!);
    const before = server.requests.length;
    await discovery.resolveLayer(config.LAYER_SPEC_BY_KEY.zoning!);
    assert.equal(server.requests.length, before, "a cached success must not re-probe");

    discovery.resetDiscoveryCache();
    await discovery.resolveLayer(config.LAYER_SPEC_BY_KEY.historic!);
    const afterFailure = server.requests.length;
    await discovery.resolveLayer(config.LAYER_SPEC_BY_KEY.historic!);
    assert.ok(
      server.requests.length > afterFailure,
      "a failed resolution must be retried, not pinned for an hour",
    );
  });

  it("resolves every layer in one pass without throwing", async () => {
    const all = await discovery.resolveAllLayers(true);
    assert.equal(all.length, config.LAYER_SPECS.length);
    for (const layer of all) {
      assert.ok(typeof layer.key === "string" && layer.key.length > 0);
      assert.ok(["env", "candidate", "web-map", "agol-item", "unresolved"].includes(layer.via));
    }
  });
});

describe("falling back when the city moves a service", () => {
  it("reads the city's own web map when every candidate URL is dead", async () => {
    const resolved = await discovery.resolveLayer({
      key: "zoning-moved",
      label: "Zoning after the city moved it",
      required: true,
      envVar: "UNUSED_ENV_VAR",
      // Every one of these is wrong, as they would be after a republish.
      candidates: [`${server.url}/Gone/MapServer`, `${server.url}/AlsoGone/MapServer`],
      layerNames: ["base zoning", "zoning"],
    });

    assert.equal(resolved.via, "web-map");
    assert.equal(resolved.url, `${server.url}/Zoning_2027/MapServer/3`);
    assert.ok(
      resolved.attempts.some((a) => a.url.includes("/Gone/MapServer")),
      "it should still record the candidates it tried",
    );
  });

  it("falls back to a statewide ArcGIS Online layer when the city has nothing", async () => {
    const resolved = await discovery.resolveLayer({
      key: "parcels-fallback",
      label: "Parcels with a statewide fallback",
      required: true,
      envVar: "UNUSED_ENV_VAR",
      candidates: [`${server.url}/Gone/MapServer`],
      // Nothing in the web map matches this, so it has to reach the item.
      layerNames: ["maine parcels"],
      agolItems: ["statewide-item"],
    });

    assert.equal(resolved.via, "agol-item");
    assert.equal(resolved.url, `${server.url}/Statewide/MapServer/0`);
  });

  it("gives up rather than returning an arbitrary layer", async () => {
    const resolved = await discovery.resolveLayer({
      key: "nothing",
      label: "A layer that does not exist anywhere",
      required: false,
      envVar: "UNUSED_ENV_VAR",
      candidates: [`${server.url}/Zoning/MapServer`],
      layerNames: ["a layer name nothing will match"],
    });

    assert.equal(resolved.url, null);
    assert.equal(resolved.via, "unresolved");
  });
});

describe("layers whose names overlap", () => {
  // These names are taken from Portland's real Zoning service, where the
  // generic overlay layer and the shoreland layer both contain "overlay zone".
  const realistic = [
    { id: 0, name: "Coastal Stability" },
    { id: 2, name: "Shoreland Overlay Zone" },
    { id: 3, name: "Stream Overlay Zone" },
    { id: 5, name: "Zoning" },
    { id: 6, name: "Overlay Zones" },
    { id: 8, name: "Zoning Lines" },
  ];

  it("does not let the shoreland layer stand in for the generic overlay layer", () => {
    const hit = discovery.matchLayerByName(
      realistic,
      ["overlay zones", "overlay zone", "overlay"],
      ["shoreland", "stream", "coastal", "historic"],
    );
    assert.equal(hit?.id, 6, `matched "${hit?.name}" instead of "Overlay Zones"`);
  });

  it("does not let an overlay stand in for the base zoning district", () => {
    const hit = discovery.matchLayerByName(
      realistic,
      ["base zoning", "zoning district", "zoning"],
      ["overlay", "shoreland", "stream", "coastal", "historic", "line"],
    );
    assert.equal(hit?.id, 5, `matched "${hit?.name}" instead of "Zoning"`);
  });

  it("still finds the shoreland layer when that is what is asked for", () => {
    assert.equal(discovery.matchLayerByName(realistic, ["shoreland"])?.id, 2);
  });

  it("resolves the real overlay and shoreland layers to different urls", async () => {
    const overlays = await discovery.resolveLayer(config.LAYER_SPEC_BY_KEY.overlays!);
    const shoreland = await discovery.resolveLayer(config.LAYER_SPEC_BY_KEY.shoreland!);
    if (overlays.url && shoreland.url) {
      assert.notEqual(
        overlays.url,
        shoreland.url,
        "the generic overlay layer must not resolve to the shoreland layer",
      );
    }
  });
});
