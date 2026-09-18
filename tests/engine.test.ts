import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { analyze } from "../src/lib/engine/envelope";
import { DEFAULT_ASSUMPTIONS } from "../src/lib/engine/assumptions";
import { findDistrict, ruleSet } from "../src/lib/rules/load";
import { fakeSite } from "./fixtures/site";

const R6 = findDistrict("R-6");
assert.ok(R6, "the test suite assumes R-6 is in the rule dataset");

describe("analyze — a 100x100 ft R-6 lot", () => {
  const result = analyze(fakeSite({ widthFt: 100, depthFt: 100 }), "123 Example St");
  const base = result.scenarios.find((s) => s.id === "base");
  assert.ok(base);

  it("reports the lot area it measured", () => {
    assert.equal(result.parcel.lotAreaSf.value, 10000);
    assert.equal(result.parcel.lotAreaSf.basis, "gis");
  });

  it("uses the district height limit and cites it", () => {
    assert.equal(base.envelope.maxHeightFt.value, R6.maxHeightFt.value);
    assert.equal(base.envelope.maxHeightFt.basis, "rule");
    assert.ok(base.envelope.maxHeightFt.citation, "height must carry a citation");
  });

  it("derives storeys from height and marks them an assumption", () => {
    const height = R6.maxHeightFt.value!;
    const expected = Math.floor(
      (height - DEFAULT_ASSUMPTIONS.roofAssemblyFt) / DEFAULT_ASSUMPTIONS.floorToFloorFt,
    );
    assert.equal(base.envelope.stories.value, expected);
    assert.equal(base.envelope.stories.basis, "assumption");
  });

  it("takes the smaller of the setback envelope and the coverage cap", () => {
    // Front 10, side 8, rear 20 leaves 70 x 84 = 5,880 sf; coverage caps at 50%
    // of 10,000 sf = 5,000 sf, so coverage governs.
    assert.equal(base.envelope.maxFootprintSf.value, 5000);
    const coverageStep = result.trace.find((s) => s.id === "coverage");
    assert.ok(coverageStep, "the coverage cap must appear in the trace");
  });

  it("computes gross floor area as footprint x storeys", () => {
    assert.equal(
      base.envelope.grossFloorAreaSf.value,
      base.envelope.maxFootprintSf.value! * base.envelope.stories.value!,
    );
  });

  it("caps units by the district density rule when that binds first", () => {
    // 10,000 sf / 1,000 sf per unit = 10 units, well below what 20,000 sf of
    // floor area could hold.
    assert.equal(base.envelope.estimatedUnits.value, 10);
    assert.equal(base.envelope.estimatedUnits.basis, "rule");
    assert.ok(base.envelope.estimatedUnits.citation);
  });

  it("explains every headline number in the trace", () => {
    for (const id of ["lot-area", "height", "setbacks", "footprint", "gfa", "units"]) {
      assert.ok(
        result.trace.some((step) => step.id === id),
        `missing trace step: ${id}`,
      );
    }
  });

  it("lists the citations it actually used", () => {
    assert.ok(result.citations.length > 0);
    for (const citation of result.citations) {
      assert.ok(citation.url.startsWith("http"), `${citation.id} has no usable url`);
      assert.ok(citation.section.length > 0);
    }
  });

  it("surfaces that the rule data is unverified", () => {
    assert.equal(result.ruleData.verified, false);
    assert.ok(result.ruleData.warning.length > 20);
  });
});

describe("analyze — frontage detection", () => {
  it("applies the largest yard everywhere when no street is known", () => {
    const withStreet = analyze(fakeSite({ withStreet: true }), "x");
    const without = analyze(fakeSite({ withStreet: false }), "x");
    const a = withStreet.trace.find((s) => s.id === "setbacks")!.result.value!;
    const b = without.trace.find((s) => s.id === "setbacks")!.result.value!;
    assert.ok(b < a, "the no-frontage fallback must be the more conservative of the two");
    assert.match(without.trace.find((s) => s.id === "setbacks")!.detail, /could not be identified/);
  });
});

describe("analyze — a district the dataset does not hold", () => {
  const result = analyze(fakeSite({ districtCode: "ZZ-9" }), "x");
  const base = result.scenarios[0]!;

  it("still produces a complete estimate — every figure has a number", () => {
    for (const [key, figure] of Object.entries(base.envelope)) {
      assert.ok(typeof figure.value === "number", `${key} should be estimated, got ${figure.value}`);
    }
  });

  it("labels the height an assumption, from the unknown-family default", () => {
    assert.equal(base.envelope.maxHeightFt.basis, "assumption");
    assert.equal(base.envelope.maxHeightFt.value, ruleSet.estimateDefaults.families.unknown.maxHeightFt);
    assert.equal(base.envelope.maxHeightFt.citation, ruleSet.estimateDefaults.citation);
  });

  it("says the district was estimated, in the trace and as a constraint", () => {
    const step = result.trace.find((s) => s.id === "district")!;
    assert.equal(step.basis, "assumption");
    assert.match(step.detail, /ZZ-9/);
    const constraint = result.constraints.find((c) => c.id === "district-estimated");
    assert.ok(constraint, "expected a district-estimated constraint");
    assert.equal(constraint.severity, "limiting");
    assert.match(constraint.title, /ZZ-9/);
    assert.equal(result.zoning.districtKnown, false);
  });

  it("infers the family from the code when it can", () => {
    const residential = analyze(fakeSite({ districtCode: "R-99" }), "x");
    assert.equal(
      residential.scenarios[0]!.envelope.maxHeightFt.value,
      ruleSet.estimateDefaults.families.residential.maxHeightFt,
    );
    const business = analyze(fakeSite({ districtCode: "B-99" }), "x");
    assert.equal(
      business.scenarios[0]!.envelope.maxHeightFt.value,
      ruleSet.estimateDefaults.families.business.maxHeightFt,
    );
  });

  it("estimates even with no district at all", () => {
    const none = analyze(fakeSite({ districtCode: null }), "x");
    assert.ok(typeof none.scenarios[0]!.envelope.maxHeightFt.value === "number");
    assert.ok(none.scenarios.some((s) => s.id === "affordable"), "the community-need pathway is always offered");
  });
});

describe("analyze — a district in the dataset with no height stated", () => {
  it("fills the blank from the family default and says which fields it estimated", () => {
    // ROS (open space) states no dimensional standards at all.
    const result = analyze(fakeSite({ districtCode: "ROS" }), "x");
    const base = result.scenarios[0]!;
    assert.equal(result.zoning.districtKnown, true);
    assert.ok(typeof base.envelope.maxHeightFt.value === "number");
    assert.equal(base.envelope.maxHeightFt.basis, "assumption");
    const fields = result.constraints.find((c) => c.id === "fields-estimated");
    assert.ok(fields, "expected a fields-estimated constraint");
    assert.match(fields.title, /maximum height/);
    // ...and still says housing is not a permitted use there.
    assert.ok(result.constraints.some((c) => c.id === "multifamily-not-allowed" && c.severity === "blocking"));
  });
});

describe("analyze — a height published on the zoning layer", () => {
  it("prefers the city's own mapped height when it is more restrictive", () => {
    const result = analyze(fakeSite({ mappedMaxHeightFt: 35 }), "x");
    const height = result.scenarios[0]!.envelope.maxHeightFt;
    assert.equal(height.value, 35);
    assert.equal(height.basis, "gis");
  });

  it("still takes the most restrictive when the table is lower", () => {
    const result = analyze(fakeSite({ mappedMaxHeightFt: 250 }), "x");
    assert.equal(result.scenarios[0]!.envelope.maxHeightFt.value, R6.maxHeightFt.value);
  });
});

describe("analyze — overlays", () => {
  const result = analyze(
    fakeSite({
      widthFt: 200,
      depthFt: 200,
      overlays: [{ ruleId: "shoreland", name: "Shoreland Overlay Zone", layerKey: "shoreland" }],
    }),
    "x",
  );

  it("applies the shoreland setback and coverage cap", () => {
    const plain = analyze(fakeSite({ widthFt: 200, depthFt: 200 }), "x");
    assert.ok(
      result.scenarios[0]!.envelope.maxFootprintSf.value! <
        plain.scenarios[0]!.envelope.maxFootprintSf.value!,
      "the shoreland overlay must reduce the footprint",
    );
  });

  it("reports it as a constraint that a board decides", () => {
    const constraint = result.constraints.find((c) => c.id === "overlay-shoreland");
    assert.ok(constraint);
    assert.equal(constraint.discretionary, true);
  });

  it("records an unmapped overlay as a gap rather than ignoring it", () => {
    const unknown = analyze(
      fakeSite({ overlays: [{ ruleId: null, name: "Mystery Overlay", layerKey: "overlays" }] }),
      "x",
    );
    assert.ok(unknown.gaps.some((g) => g.includes("Mystery Overlay")));
  });
});

describe("analyze — the state affordable-housing pathway", () => {
  const result = analyze(fakeSite(), "x");
  const base = result.scenarios.find((s) => s.id === "base")!;
  const affordable = result.scenarios.find((s) => s.id === "affordable");

  it("is offered as a separate scenario, not folded into the base answer", () => {
    assert.ok(affordable, "expected an affordable-housing scenario");
    assert.notEqual(affordable.envelope.maxHeightFt.value, base.envelope.maxHeightFt.value);
  });

  it("adds at least one storey or 14 ft of height, whichever is greater", () => {
    const bonus = affordable!.envelope.maxHeightFt.value! - base.envelope.maxHeightFt.value!;
    assert.ok(bonus >= 14, `expected at least 14 ft of bonus, got ${bonus}`);
  });

  it("multiplies the density cap by 2.5", () => {
    assert.equal(affordable!.envelope.estimatedUnits.value, 25);
  });

  it("cites the statute rather than the local code", () => {
    assert.equal(affordable!.envelope.maxHeightFt.basis, "statute");
    assert.ok(affordable!.statuteCitation);
  });
});

describe("analyze — small lots", () => {
  it("flags a lot the setbacks swallow entirely, and estimates under a variance", () => {
    const result = analyze(fakeSite({ widthFt: 20, depthFt: 20, withStreet: false }), "x");
    assert.ok(result.constraints.some((c) => c.id === "no-buildable-area" && c.severity === "blocking"));
    // The setback envelope is zero, so the coverage cap stands in for it.
    const setbacks = result.trace.find((s) => s.id === "setbacks")!;
    assert.equal(setbacks.result.value, 0);
    assert.equal(result.scenarios[0]!.envelope.maxFootprintSf.value, Math.round(400 * R6.maxLotCoverageRatio.value!));
    assert.ok(result.gaps.some((g) => g.includes("variance")));
  });

  it("notes the statutory unit floor when the district allows fewer", () => {
    const result = analyze(fakeSite({ widthFt: 40, depthFt: 60 }), "x");
    const units = result.scenarios[0]!.envelope.estimatedUnits.value;
    if (units !== null && units < 4) {
      assert.ok(result.constraints.some((c) => c.id === "statutory-unit-floor"));
    }
  });
});

describe("analyze — cross-checks", () => {
  it("flags a mismatch between the mapped and recorded lot area", () => {
    const result = analyze(fakeSite({ widthFt: 100, depthFt: 100, recordedAreaSf: 4000 }), "x");
    assert.ok(result.gaps.some((g) => g.includes("assessor")));
  });

  it("does not flag a small difference", () => {
    const result = analyze(fakeSite({ widthFt: 100, depthFt: 100, recordedAreaSf: 9800 }), "x");
    assert.ok(!result.gaps.some((g) => g.includes("assessor")));
  });
});

describe("figures that are not quantities", () => {
  it("renders the district step as its code, not as 'not determined'", () => {
    const result = analyze(fakeSite(), "x");
    const step = result.trace.find((s) => s.id === "district")!;
    assert.equal(step.result.value, null);
    assert.equal(step.result.text, "R-6");
  });
});
