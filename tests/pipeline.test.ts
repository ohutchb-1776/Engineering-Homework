/**
 * End-to-end: address string in, full analysis out, against a fake ArcGIS
 * server. This covers the part of the app the unit tests cannot — field
 * resolution against a real layer response, the SQL the client builds, the
 * Esri-to-GeoJSON conversion, and how an unreachable optional layer surfaces.
 */
import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { startFakeArcgis, type FakeArcgis, type FakeLayer } from "./helpers/fake-arcgis";
import { makeProjector, type LonLat } from "../src/lib/geometry/project";

const ORIGIN: LonLat = [-70.2568, 43.6591];

/** An Esri polygon ring for a lot `w` x `d` feet anchored at ORIGIN. */
function esriRing(w: number, d: number): number[][] {
  const projector = makeProjector(ORIGIN);
  return [
    [0, 0],
    [w, 0],
    [w, d],
    [0, d],
    [0, 0],
  ].map((corner) => [...projector.toLonLat(corner as [number, number])]);
}

const parcelLayer: FakeLayer = {
  name: "Parcels",
  geometryType: "esriGeometryPolygon",
  // Deliberately a field naming the app has to resolve rather than assume.
  fields: [
    { name: "OBJECTID", type: "esriFieldTypeOID" },
    { name: "PROP_LOC", type: "esriFieldTypeString" },
    { name: "CBL", type: "esriFieldTypeString" },
    { name: "SHAPE_AREA", type: "esriFieldTypeDouble" },
  ],
  features: [
    {
      attributes: { OBJECTID: 1, PROP_LOC: "155 BRACKETT ST", CBL: "041 A012", SHAPE_AREA: 123.4 },
      // 300 x 300 ft, big enough that the shoreland overlay's 75 ft setback
      // still leaves something to build on.
      geometry: { rings: [esriRing(300, 300)] },
    },
    {
      attributes: { OBJECTID: 2, PROP_LOC: "157 BRACKETT ST", CBL: "041 A013", SHAPE_AREA: 99 },
      geometry: { rings: [esriRing(80, 100)] },
    },
    {
      attributes: { OBJECTID: 3, PROP_LOC: "9 O'BRION ST", CBL: "041 A014", SHAPE_AREA: 50 },
      geometry: { rings: [esriRing(60, 60)] },
    },
  ],
};

const zoningLayer: FakeLayer = {
  name: "Zoning",
  geometryType: "esriGeometryPolygon",
  fields: [
    { name: "ZONE_", type: "esriFieldTypeString" },
    { name: "ZONE_NAME", type: "esriFieldTypeString" },
  ],
  features: [{ attributes: { ZONE_: "R-6", ZONE_NAME: "High Density Residential" } }],
};

const emptyLayer = (name: string): FakeLayer => ({
  name,
  geometryType: "esriGeometryPolygon",
  fields: [{ name: "NAME", type: "esriFieldTypeString" }],
  features: [],
});

let server: FakeArcgis;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runAnalysis: (address: string) => Promise<any>;

before(async () => {
  server = await startFakeArcgis({
    parcels: parcelLayer,
    zoning: zoningLayer,
    overlays: emptyLayer("Overlays"),
    empty: emptyLayer("Empty"),
    shoreland: {
      ...emptyLayer("Shoreland"),
      features: [{ attributes: { NAME: "Shoreland Overlay Zone" } }],
    },
    stream: emptyLayer("Stream"),
    coastal: emptyLayer("Coastal"),
    // Historic is deliberately broken, to test the "unavailable" path.
    historic: { ...emptyLayer("Historic"), fail: 503 },
    flood: {
      name: "Flood",
      geometryType: "esriGeometryPolygon",
      fields: [{ name: "FLD_ZONE", type: "esriFieldTypeString" }],
      features: [{ attributes: { FLD_ZONE: "AE" } }],
    },
    streets: {
      name: "Streets",
      geometryType: "esriGeometryPolyline",
      fields: [{ name: "STREET_NAME", type: "esriFieldTypeString" }],
      features: [
        {
          attributes: { STREET_NAME: "BRACKETT ST" },
          geometry: {
            paths: [
              [
                [...makeProjector(ORIGIN).toLonLat([-200, -20])],
                [...makeProjector(ORIGIN).toLonLat([200, -20])],
              ],
            ],
          },
        },
      ],
    },
  });

  // config.ts reads the environment when it is first imported, so the
  // endpoints have to be set before anything pulls it in.
  process.env.PORTLAND_PARCEL_LAYER = `${server.url}/parcels`;
  // Keep every discovery attempt inside the fake server, so nothing reaches
  // for the real city GIS from a unit test.
  process.env.PORTLAND_GIS_ROOT = server.url;
  process.env.AGOL_SHARING_URL = `${server.url}/sharing/rest`;
  process.env.PORTLAND_ADDRESS_POINTS_LAYER = `${server.url}/empty`;
  process.env.PORTLAND_ZONING_LAYER = `${server.url}/zoning`;
  process.env.PORTLAND_OVERLAY_LAYER = `${server.url}/overlays`;
  process.env.PORTLAND_SHORELAND_LAYER = `${server.url}/shoreland`;
  process.env.PORTLAND_STREAM_LAYER = `${server.url}/stream`;
  process.env.PORTLAND_COASTAL_LAYER = `${server.url}/coastal`;
  process.env.PORTLAND_HISTORIC_LAYER = `${server.url}/historic`;
  process.env.FEMA_NFHL_LAYER = `${server.url}/flood`;
  process.env.PORTLAND_STREETS_LAYER = `${server.url}/streets`;

  ({ runAnalysis } = await import("../src/lib/engine/run"));
});

after(async () => {
  await server.close();
});

describe("runAnalysis against a live-shaped ArcGIS service", () => {
  it("resolves an address, reads the district, and returns an envelope", async () => {
    const outcome = await runAnalysis("155 Brackett Street");
    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.message);

    const result = outcome.result;
    assert.equal(result.address.matched, "155 BRACKETT ST");
    assert.equal(result.address.parcelId, "041 A012");
    assert.equal(result.zoning.districtCode, "R-6");
    assert.equal(result.zoning.districtKnown, true);

    // The lot is 300 x 300 ft; geodesic area lands within a fraction of a
    // percent of 90,000 sf.
    const lotArea = result.parcel.lotAreaSf.value as number;
    assert.ok(Math.abs(lotArea - 90000) / 90000 < 0.005, `lot area was ${lotArea}`);

    const base = result.scenarios[0];
    assert.ok((base.envelope.maxHeightFt.value as number) > 0);
    assert.ok((base.envelope.stories.value as number) > 0);
    assert.ok((base.envelope.maxFootprintSf.value as number) > 0);
    assert.ok((base.envelope.estimatedUnits.value as number) > 0);
  });

  it("normalises the address into the SQL it sends", async () => {
    server.requests.length = 0;
    await runAnalysis("155 brackett street");
    const query = server.requests.find((r) => r.startsWith("/parcels/query"));
    assert.ok(query);
    const where = new URL(query, "http://localhost").searchParams.get("where");
    assert.equal(where, "UPPER(PROP_LOC) LIKE '155 BRACKETT ST%'");
  });

  it("escapes an apostrophe rather than breaking the query", async () => {
    server.requests.length = 0;
    const outcome = await runAnalysis("9 O'Brion St");
    const query = server.requests.find((r) => r.startsWith("/parcels/query"))!;
    assert.equal(
      new URL(query, "http://localhost").searchParams.get("where"),
      "UPPER(PROP_LOC) LIKE '9 O''BRION ST%'",
    );
    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.message);
    assert.equal(outcome.result.address.parcelId, "041 A014");
  });

  it("converts Esri rings into a polygon the map can draw", async () => {
    const outcome = await runAnalysis("155 Brackett St");
    const geometry = outcome.result.parcel.geometry;
    assert.ok(["Polygon", "MultiPolygon"].includes(geometry.type));
    assert.ok(outcome.result.parcel.buildableGeometry, "expected a buildable envelope to draw");
  });

  it("picks up an overlay from its own layer and lets it shrink the footprint", async () => {
    const outcome = await runAnalysis("155 Brackett St");
    assert.ok(outcome.result.overlays.some((o: { id: string | null }) => o.id === "shoreland"));
    assert.ok(outcome.result.constraints.some((c: { id: string }) => c.id === "overlay-shoreland"));

    // 300 x 300 ft with R-6 yards alone would leave far more than this; the
    // overlay's additional 75 ft on every line is what brings it down.
    const footprint = outcome.result.scenarios[0].envelope.maxFootprintSf.value as number;
    assert.ok(footprint > 0 && footprint < 20000, `footprint was ${footprint}`);
  });

  it("reports an unreachable optional layer as a gap, not as an absence", async () => {
    const outcome = await runAnalysis("155 Brackett St");
    assert.ok(
      outcome.result.gaps.some((g: string) => g.includes("Historic")),
      "a 503 on the historic layer must surface as a gap",
    );
    assert.ok(
      outcome.result.sources.some(
        (s: { key: string; status: string }) => s.key === "historic" && s.status === "unavailable",
      ),
    );
  });

  it("uses the street centreline to identify the front lot line", async () => {
    const outcome = await runAnalysis("155 Brackett St");
    const setbacks = outcome.result.trace.find((s: { id: string }) => s.id === "setbacks");
    assert.match(setbacks.detail, /front line was identified/);
  });

  it("refuses an address that matches nothing", async () => {
    const outcome = await runAnalysis("99999 Nowhere Rd");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.kind, "not-found");
  });

  it("rejects an empty query before touching the network", async () => {
    const outcome = await runAnalysis("   ");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.kind, "bad-request");
  });
});

describe("naming", () => {
  it("gives a bare FEMA zone code a readable name", async () => {
    const outcome = await runAnalysis("155 Brackett St");
    const flood = outcome.result.overlays.find(
      (o: { id: string | null }) => o.id === "flood-zone-ae",
    );
    assert.ok(flood, "expected the flood overlay");
    assert.match(flood.name, /zone AE$/);
    assert.notEqual(flood.name, "AE");
  });
});
