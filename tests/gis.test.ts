import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { houseNumberOf, looksLikeStreetAddress, normalizeAddress, streetLineOf } from "../src/lib/gis/address";
import { asNumber, asString, resolveField } from "../src/lib/gis/fields";
import { inferOverlayRuleId } from "../src/lib/gis/site";
import { findOverlay } from "../src/lib/rules/load";
import type { LayerField } from "../src/lib/gis/arcgis";

const fields = (...names: string[]): LayerField[] => names.map((name) => ({ name, type: "esriFieldTypeString" }));

describe("normalizeAddress", () => {
  it("canonicalises case, punctuation and street suffixes", () => {
    assert.equal(normalizeAddress("123 example street"), "123 EXAMPLE ST");
    assert.equal(normalizeAddress("  45  Congress  Street  "), "45 CONGRESS ST");
    assert.equal(normalizeAddress("77 Free St."), "77 FREE ST");
  });

  it("canonicalises directionals", () => {
    assert.equal(normalizeAddress("12 North Ave"), "12 N AVE");
  });

  it("drops the city, state and ZIP", () => {
    assert.equal(normalizeAddress("389 Congress Street, Portland, ME 04101"), "389 CONGRESS ST");
  });

  it("never rewrites the house number", () => {
    // "ST" is a suffix everywhere except at the front of the line.
    assert.equal(normalizeAddress("1 Street Ave"), "1 ST AVE");
  });

  it("leaves unrecognised street names alone", () => {
    assert.equal(normalizeAddress("100 Commercial"), "100 COMMERCIAL");
    assert.equal(normalizeAddress("10 Eastern Promenade"), "10 EASTERN PROM");
  });
});

describe("address helpers", () => {
  it("extracts the house number", () => {
    assert.equal(houseNumberOf("123 Example St"), "123");
    assert.equal(houseNumberOf("123A Example St"), "123A");
    assert.equal(houseNumberOf("Monument Square"), null);
  });

  it("recognises a street address", () => {
    assert.ok(looksLikeStreetAddress("12 Deering Ave"));
    assert.ok(!looksLikeStreetAddress("Monument Square"));
  });

  it("keeps only the street line", () => {
    assert.equal(streetLineOf("1 City Center, Portland, ME"), "1 City Center");
  });
});

describe("resolveField", () => {
  it("finds the most specific candidate the layer actually has", () => {
    assert.equal(resolveField(fields("OBJECTID", "ADDRESS", "FULL_ADDRESS"), "address"), "FULL_ADDRESS");
    assert.equal(resolveField(fields("OBJECTID", "ADDRESS"), "address"), "ADDRESS");
  });

  it("is case-insensitive, because ArcGIS layers are not consistent", () => {
    assert.equal(resolveField(fields("Zone_Code"), "zoningDistrict"), "Zone_Code");
  });

  it("returns null rather than guessing when nothing matches", () => {
    assert.equal(resolveField(fields("OBJECTID", "SHAPE"), "address"), null);
  });

  it("knows the common Portland parcel identifier", () => {
    assert.equal(resolveField(fields("OBJECTID", "CBL"), "parcelId"), "CBL");
  });
});

describe("attribute coercion", () => {
  it("treats empty and null-ish values as missing", () => {
    assert.equal(asString(null), null);
    assert.equal(asString(""), null);
    assert.equal(asString("   "), null);
    assert.equal(asString("Null"), null);
    assert.equal(asString(" R-6 "), "R-6");
  });

  it("only accepts finite numbers", () => {
    assert.equal(asNumber("45"), 45);
    assert.equal(asNumber(""), null);
    assert.equal(asNumber("n/a"), null);
    assert.equal(asNumber(null), null);
    assert.equal(asNumber(0), 0);
  });
});

describe("inferOverlayRuleId", () => {
  it("maps overlay names onto rules the engine holds", () => {
    const cases: [string, string][] = [
      ["Shoreland Overlay Zone", "shoreland"],
      ["STREAM PROTECTION", "stream-protection"],
      ["Coastal Bluff", "coastal-stability"],
      ["Congress Street Historic District", "historic-district"],
      ["Jetport Approach Surface", "airport-approach"],
      ["AE", "flood-zone-ae"],
    ];
    for (const [name, expected] of cases) {
      assert.equal(inferOverlayRuleId(name), expected, `failed on "${name}"`);
      assert.ok(findOverlay(expected), `rule dataset has no overlay "${expected}"`);
    }
  });

  it("returns null for a name it does not recognise, so the caller records a gap", () => {
    assert.equal(inferOverlayRuleId("Some Future Overlay"), null);
    assert.equal(inferOverlayRuleId(null), null);
  });
});
