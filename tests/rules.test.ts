import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { findCitation, findDistrict, normalizeDistrictCode, ruleSet } from "../src/lib/rules/load";
import type { Sourced } from "../src/lib/rules/schema";

const CONFIDENCES = new Set(["verified", "needs-verification", "not-stated"]);

/** Every Sourced value on every district, flattened for bulk assertions. */
function* everySourcedValue(): Generator<{ path: string; value: Sourced<unknown> }> {
  for (const d of ruleSet.districts) {
    const scalars: [string, Sourced<unknown>][] = [
      ["multifamilyAllowed", d.multifamilyAllowed],
      ["maxHeightFt", d.maxHeightFt],
      ["maxStories", d.maxStories],
      ["minLotAreaSf", d.minLotAreaSf],
      ["minLotAreaPerDwellingSf", d.minLotAreaPerDwellingSf],
      ["maxFar", d.maxFar],
      ["maxLotCoverageRatio", d.maxLotCoverageRatio],
      ["minStreetFrontageFt", d.minStreetFrontageFt],
      ["parkingSpacesPerDwelling", d.parkingSpacesPerDwelling],
      ["minYardsFt.front", d.minYardsFt.front],
      ["minYardsFt.side", d.minYardsFt.side],
      ["minYardsFt.rear", d.minYardsFt.rear],
    ];
    for (const [key, value] of scalars) yield { path: `${d.code}.${key}`, value };
  }
}

describe("rule dataset", () => {
  it("declares which code edition it was transcribed from", () => {
    assert.ok(ruleSet.codeEdition.length > 0);
    assert.match(ruleSet.codeEffectiveDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(ruleSet.version.length > 0);
  });

  it("states its own provenance, including whether it has been verified", () => {
    assert.equal(typeof ruleSet.provenance.verifiedAgainstPrimarySource, "boolean");
    assert.ok(ruleSet.provenance.method.length > 40);
    assert.ok(ruleSet.provenance.warning.length > 40);
  });

  it("has no duplicate district codes", () => {
    const seen = new Set<string>();
    for (const d of ruleSet.districts) {
      const key = normalizeDistrictCode(d.code);
      assert.ok(!seen.has(key), `duplicate district ${d.code}`);
      seen.add(key);
    }
  });

  it("gives every value a citation that exists", () => {
    for (const { path, value } of everySourcedValue()) {
      assert.ok(value.source, `${path} has no source`);
      assert.ok(findCitation(value.source), `${path} cites unknown source "${value.source}"`);
    }
  });

  it("gives every value a recognised confidence", () => {
    for (const { path, value } of everySourcedValue()) {
      assert.ok(CONFIDENCES.has(value.confidence), `${path} has confidence "${value.confidence}"`);
    }
  });

  it("marks a value 'not-stated' exactly when it is null", () => {
    for (const { path, value } of everySourcedValue()) {
      if (value.value === null) {
        assert.equal(value.confidence, "not-stated", `${path} is null but not marked not-stated`);
      } else {
        assert.notEqual(value.confidence, "not-stated", `${path} has a value but is marked not-stated`);
      }
    }
  });

  it("keeps every numeric value inside a physically sane range", () => {
    for (const d of ruleSet.districts) {
      const height = d.maxHeightFt.value;
      if (height !== null) assert.ok(height > 0 && height <= 1000, `${d.code} height ${height}`);

      const coverage = d.maxLotCoverageRatio.value;
      if (coverage !== null) assert.ok(coverage > 0 && coverage <= 1, `${d.code} coverage ${coverage}`);

      const perUnit = d.minLotAreaPerDwellingSf.value;
      if (perUnit !== null) assert.ok(perUnit > 0 && perUnit <= 200_000, `${d.code} sf/unit ${perUnit}`);

      for (const key of ["front", "side", "rear"] as const) {
        const yard = d.minYardsFt[key].value;
        if (yard !== null) assert.ok(yard >= 0 && yard <= 200, `${d.code} ${key} yard ${yard}`);
      }

      const parking = d.parkingSpacesPerDwelling.value;
      if (parking !== null) assert.ok(parking >= 0 && parking <= 4, `${d.code} parking ${parking}`);
    }
  });

  it("gives every citation a document, a section and a resolvable url", () => {
    for (const c of ruleSet.citations) {
      assert.ok(c.document.length > 0, `${c.id} has no document`);
      assert.ok(c.section.length > 0, `${c.id} has no section`);
      assert.match(c.url, /^https:\/\//, `${c.id} url is not https`);
      assert.ok(c.edition.length > 0, `${c.id} has no edition`);
    }
  });

  it("has no unreferenced citations", () => {
    const referenced = new Set<string>();
    for (const { value } of everySourcedValue()) referenced.add(value.source);
    for (const o of ruleSet.overlays) {
      for (const effect of Object.values(o.effect)) {
        if (effect && typeof effect === "object" && "source" in effect) {
          referenced.add((effect as Sourced<unknown>).source);
        }
      }
    }
    for (const o of ruleSet.overlays) referenced.add(o.citation);
    for (const p of ruleSet.statutePathways) referenced.add(p.source);
    referenced.add(ruleSet.codeCitation);
    referenced.add(ruleSet.inclusionaryZoning.citation);
    referenced.add(ruleSet.estimateDefaults.citation);

    for (const c of ruleSet.citations) {
      assert.ok(referenced.has(c.id), `citation "${c.id}" is never used`);
    }
  });

  it("gives every overlay an id, a description and a known kind", () => {
    const kinds = new Set(["height-cap", "coverage-cap", "setback", "review", "informational"]);
    const seen = new Set<string>();
    for (const o of ruleSet.overlays) {
      assert.ok(!seen.has(o.id), `duplicate overlay ${o.id}`);
      seen.add(o.id);
      assert.ok(kinds.has(o.kind), `${o.id} has kind "${o.kind}"`);
      assert.ok(o.description.length > 30, `${o.id} needs a usable description`);
      assert.ok(findCitation(o.citation), `${o.id} cites unknown source "${o.citation}"`);
      assert.equal(typeof o.triggersDiscretionaryReview, "boolean");
    }
  });

  it("states an inclusionary-zoning threshold in data, not in code", () => {
    const iz = ruleSet.inclusionaryZoning;
    assert.ok(iz.unitThreshold > 0);
    assert.ok(findCitation(iz.citation));
    assert.ok(iz.summary.length > 40);
  });

  it("backs every statutory pathway with a verified citation and stated conditions", () => {
    for (const p of ruleSet.statutePathways) {
      assert.ok(findCitation(p.source), `${p.id} cites unknown source`);
      assert.equal(p.confidence, "verified", `${p.id} should be read from the statute itself`);
      assert.ok(p.conditions.length > 0, `${p.id} states no conditions`);
    }
  });
});

describe("estimating defaults", () => {
  const families = ["residential", "mixed-use", "business", "industrial", "institutional", "island", "other", "unknown"];

  it("cover every district family, plus unknown", () => {
    for (const family of families) {
      assert.ok(ruleSet.estimateDefaults.families[family as keyof typeof ruleSet.estimateDefaults.families], `missing family ${family}`);
    }
  });

  it("are complete and physically sane, so an estimate can always be produced", () => {
    for (const [family, d] of Object.entries(ruleSet.estimateDefaults.families)) {
      assert.ok(d.maxHeightFt > 0 && d.maxHeightFt <= 300, `${family} height`);
      assert.ok(d.maxLotCoverageRatio > 0 && d.maxLotCoverageRatio <= 1, `${family} coverage`);
      for (const key of ["front", "side", "rear"] as const) {
        assert.ok(d.minYardsFt[key] >= 0 && d.minYardsFt[key] <= 100, `${family} ${key} yard`);
      }
      if (d.minLotAreaPerDwellingSf !== null) assert.ok(d.minLotAreaPerDwellingSf > 0, `${family} density`);
      assert.equal(typeof d.multifamilyAllowed, "boolean");
      assert.ok(d.rationale.length > 40, `${family} needs a rationale a reader can argue with`);
    }
  });

  it("cite something a reader can open", () => {
    assert.ok(findCitation(ruleSet.estimateDefaults.citation));
  });
});

describe("district lookup", () => {
  it("matches however the GIS spells the code", () => {
    for (const spelling of ["R-6", "r6", " R 6 ", "r-6"]) {
      assert.equal(findDistrict(spelling)?.code, "R-6", `failed on "${spelling}"`);
    }
  });

  it("returns null rather than a nearby district", () => {
    assert.equal(findDistrict("R-99"), null);
    assert.equal(findDistrict(null), null);
    assert.equal(findDistrict(""), null);
  });
});
