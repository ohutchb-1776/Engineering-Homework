/**
 * Finding the right parcel from what someone actually types.
 *
 * Reproduces the two ways the lookup failed in the field:
 *   - "5 Monument Sq" when the assessor recorded "5 MONUMENT SQUARE"
 *   - an address on a public square, which geocodes to the square itself and
 *     therefore lands inside no parcel at all
 */
import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { startFakeArcgis, type FakeArcgis, type FakeLayer } from "./helpers/fake-arcgis";

const ORIGIN: [number, number] = [-70.2568, 43.6591];

// Small helpers that work in degrees directly, so the fixture geometry and the
// fake server's crude spatial filter agree.
const D = 0.0002; // roughly 70 ft of latitude
const ring = (cx: number, cy: number, half = D): number[][] => [
  [cx - half, cy - half],
  [cx + half, cy - half],
  [cx + half, cy + half],
  [cx - half, cy + half],
  [cx - half, cy - half],
];

/** The square itself: a hole in the parcel fabric, with lots around it. */
const SQUARE_CENTRE: [number, number] = [ORIGIN[0], ORIGIN[1]];
const ADJACENT_LOT: [number, number] = [ORIGIN[0] + 0.0005, ORIGIN[1]];
const FAR_LOT: [number, number] = [ORIGIN[0] + 0.02, ORIGIN[1]];

const parcels: FakeLayer = {
  name: "Parcels",
  geometryType: "esriGeometryPolygon",
  fields: [
    { name: "PROP_LOC", type: "esriFieldTypeString" },
    { name: "CBL", type: "esriFieldTypeString" },
  ],
  features: [
    {
      // Recorded with the suffix spelled out, which is what broke the match.
      attributes: { PROP_LOC: "5 MONUMENT SQUARE", CBL: "028 A001" },
      geometry: { rings: [ring(ADJACENT_LOT[0], ADJACENT_LOT[1])] },
    },
    {
      // No suffix at all in the record, which the strict prefix cannot match.
      attributes: { PROP_LOC: "7 MONUMENT", CBL: "028 A007" },
      geometry: { rings: [ring(ADJACENT_LOT[0] + 0.0006, ADJACENT_LOT[1])] },
    },
    {
      attributes: { PROP_LOC: "389 CONGRESS ST", CBL: "028 B002" },
      geometry: { rings: [ring(FAR_LOT[0], FAR_LOT[1])] },
    },
  ],
};

let server: FakeArcgis;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runAnalysis: (address: string) => Promise<any>;

before(async () => {
  server = await startFakeArcgis(
    {
      parcels,
      zoning: {
        name: "Zoning",
        geometryType: "esriGeometryPolygon",
        fields: [{ name: "ZONE_", type: "esriFieldTypeString" }],
        features: [{ attributes: { ZONE_: "B-3" } }],
      },
      empty: {
        name: "Empty",
        geometryType: "esriGeometryPolygon",
        fields: [{ name: "NAME", type: "esriFieldTypeString" }],
        features: [],
      },
    },
    {
      geocoder: {
        // Lands in the middle of the square, inside no parcel — the exact
        // shape of the reported failure.
        "1 MONUMENT SQ": SQUARE_CENTRE,
        // Lands out in the harbour, nowhere near a lot.
        "1 OFFSHORE RD": [ORIGIN[0] - 0.05, ORIGIN[1] - 0.05],
      },
    },
  );

  process.env.PORTLAND_PARCEL_LAYER = `${server.url}/parcels`;
  process.env.PORTLAND_ZONING_LAYER = `${server.url}/zoning`;
  for (const key of [
    "PORTLAND_OVERLAY_LAYER",
    "PORTLAND_SHORELAND_LAYER",
    "PORTLAND_STREAM_LAYER",
    "PORTLAND_COASTAL_LAYER",
    "PORTLAND_HISTORIC_LAYER",
    "FEMA_NFHL_LAYER",
    "PORTLAND_STREETS_LAYER",
  ]) {
    process.env[key] = `${server.url}/empty`;
  }
  // Stand in for the Census geocoder: "5 Monument Sq" lands in the square,
  // which is exactly the case that used to fail.
  process.env.CENSUS_GEOCODER_URL = `${server.url}/geocode`;

  ({ runAnalysis } = await import("../src/lib/engine/run"));
});

after(async () => {
  await server.close();
});

describe("matching an address the assessor spelled differently", () => {
  it("finds '5 Monument Sq' when the record says '5 MONUMENT SQUARE'", async () => {
    const outcome = await runAnalysis("5 Monument Sq");
    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.message);
    assert.equal(outcome.result.address.parcelId, "028 A001");
  });

  it("works from the spelled-out form too", async () => {
    const outcome = await runAnalysis("5 Monument Square");
    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.message);
    assert.equal(outcome.result.address.parcelId, "028 A001");
  });

  it("finds a record stored with no suffix at all by dropping the typed one", async () => {
    const outcome = await runAnalysis("7 Monument Sq");
    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.message);
    assert.equal(outcome.result.address.parcelId, "028 A007");
  });

  it("says when it had to loosen the comparison, rather than hiding it", async () => {
    const outcome = await runAnalysis("7 Monument Sq");
    const parcelSource = outcome.result.sources.find((s: { key: string }) => s.key === "parcels");
    assert.match(parcelSource.detail, /street suffix/);
  });

  it("still refuses an address that matches nothing at all", async () => {
    const outcome = await runAnalysis("9999 Nowhere Rd");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.kind, "not-found");
  });
});

describe("an address that geocodes onto a public square", () => {
  it("uses the nearest parcel instead of giving up", async () => {
    const outcome = await runAnalysis("1 Monument Sq");
    assert.equal(
      outcome.ok,
      true,
      outcome.ok ? "" : `still failing: ${outcome.message}`,
    );
    assert.equal(outcome.result.address.parcelId, "028 A001");
  });

  it("tells the reader it did that, and to check the map", async () => {
    const outcome = await runAnalysis("1 Monument Sq");
    const gap = outcome.result.gaps.find((g: string) => g.includes("not inside any parcel"));
    assert.ok(gap, "the substitution must be visible, not silent");
    assert.match(gap, /nearest parcel/);
    assert.match(outcome.result.address.matchMethod, /nearest/i);
  });

  it("still refuses when nothing is anywhere near the geocoded point", async () => {
    const outcome = await runAnalysis("1 Offshore Rd");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.kind, "not-found");
    assert.match(outcome.message, /within 300 ft/);
  });
});

describe("when the address field misses", () => {
  it("names the field it searched, so the cause can be told apart", async () => {
    const outcome = await runAnalysis("1 Monument Sq");
    const gap = outcome.result.gaps.find((g: string) => g.includes("PROP_LOC"));
    assert.ok(gap, "the failed field comparison must be reported");
    assert.match(gap, /geocoded instead/);
  });
});
