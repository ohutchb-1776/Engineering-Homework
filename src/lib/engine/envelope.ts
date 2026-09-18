/**
 * The calculation.
 *
 * Deterministic, ordered, and traced. Each step records what it used and why,
 * so the page can show the derivation rather than a bare number. Nothing in
 * here guesses: a missing rule value produces a null figure and an entry in
 * `gaps`, which the UI renders as "not determined" rather than silently
 * dropping the constraint.
 */
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import area from "@turf/area";
import { makeProjector, type FeetXY, type LonLat } from "../geometry/project";
import { applySetbacks, classifyEdges, uniformYard, type RequiredYardsFt } from "../geometry/setbacks";
import { findCitation, findDistrict, findOverlay, ruleSet, statutePathway } from "../rules/load";
import type { DistrictRules, OverlayRules } from "../rules/schema";
import { SQ_FT_PER_SQ_M, type SiteData } from "../gis/site";
import { DEFAULT_ASSUMPTIONS, describeAssumptions, type EngineAssumptions } from "./assumptions";
import type {
  AnalysisResult,
  Constraint,
  Envelope,
  Figure,
  Scenario,
  TraceStep,
} from "./types";

export function analyze(
  site: SiteData,
  query: string,
  assumptions: EngineAssumptions = DEFAULT_ASSUMPTIONS,
): AnalysisResult {
  const trace: TraceStep[] = [];
  const constraints: Constraint[] = [];
  const gaps = [...site.gaps];
  const usedCitations = new Set<string>();

  const note = (id: string | undefined) => {
    if (id) usedCitations.add(id);
    return id;
  };

  // ---------------------------------------------------------------- lot area
  const lotAreaSf = Math.round(site.parcel.computedAreaSf);
  trace.push({
    id: "lot-area",
    label: "Lot area",
    basis: "gis",
    detail: `Measured from the city's parcel boundary${
      site.parcel.parcelId ? ` for parcel ${site.parcel.parcelId}` : ""
    }.`,
    result: {
      value: lotAreaSf,
      unit: "sf",
      basis: "gis",
      why: "Geodesic area of the parcel polygon published by the City of Portland.",
    },
  });

  if (site.parcel.recordedAreaSf && lotAreaSf > 0) {
    const drift = Math.abs(site.parcel.recordedAreaSf - lotAreaSf) / lotAreaSf;
    if (drift > 0.1) {
      gaps.push(
        `The assessor records ${Math.round(site.parcel.recordedAreaSf).toLocaleString()} sf for this lot but the mapped boundary measures ${lotAreaSf.toLocaleString()} sf. Confirm the lot area before relying on the result.`,
      );
    }
  }

  // ----------------------------------------------------------------- zoning
  const district = findDistrict(site.zoning.districtCode);
  const districtKnown = district !== null;

  if (!districtKnown) {
    gaps.push(
      site.zoning.districtCode
        ? `Zoning district "${site.zoning.districtCode}" is not in this app's rule dataset, so no dimensional standards could be applied.`
        : "No zoning district could be read for this parcel.",
    );
    constraints.push({
      id: "unknown-district",
      title: "Zoning district not in the rule dataset",
      severity: "blocking",
      detail:
        "Without the district's dimensional standards there is no defensible envelope to calculate. Check the district on the city's zoning map and add it to data/rules/portland-me.json.",
      discretionary: false,
    });
  } else {
    trace.push({
      id: "district",
      label: "Zoning district",
      basis: "gis",
      detail: `The parcel centre falls in ${district.code} (${district.name}), read from the city's zoning layer.`,
      result: {
        value: null,
        unit: "district",
        text: district.code,
        basis: "gis",
        why: "City of Portland zoning district polygons.",
      },
    });
    if (district.multifamilyAllowed.value === false) {
      constraints.push({
        id: "multifamily-not-allowed",
        title: `Apartments are not a base permitted use in ${district.code}`,
        severity: "blocking",
        detail:
          "The figures below describe the dimensional envelope only. State law still requires that at least 3-4 dwelling units per lot be allowed where residential use is permitted — see the statewide pathway.",
        citation: note(district.multifamilyAllowed.source),
        discretionary: false,
      });
    }
  }

  // --------------------------------------------------------------- overlays
  const overlayRules: OverlayRules[] = [];
  const overlayOut: AnalysisResult["overlays"] = [];
  for (const hit of site.overlays) {
    const rule = findOverlay(hit.ruleId);
    if (rule) {
      overlayRules.push(rule);
      overlayOut.push({ id: rule.id, name: hit.name, description: rule.description });
      constraints.push({
        id: `overlay-${rule.id}`,
        title: rule.name,
        severity: rule.triggersDiscretionaryReview ? "limiting" : "advisory",
        detail: rule.description,
        citation: note(rule.citation),
        discretionary: rule.triggersDiscretionaryReview,
      });
    } else {
      overlayOut.push({ id: null, name: hit.name, description: null });
      gaps.push(
        `The GIS reports an overlay named "${hit.name}" that this app has no rule for. Its effect on the envelope is unknown.`,
      );
    }
  }

  // ----------------------------------------------------------------- height
  const heightResult = resolveHeight(district, site, overlayRules, trace, note);

  // ------------------------------------------------------------- footprint
  const footprint = resolveFootprint(
    district,
    site,
    overlayRules,
    lotAreaSf,
    trace,
    constraints,
    gaps,
    note,
  );

  // ------------------------------------------------------------- scenarios
  const base = buildScenario({
    id: "base",
    label: "Base zoning",
    premise: districtKnown
      ? `What ${district.code} allows by right, before any bonus or discretionary approval.`
      : "No district standards available.",
    heightFt: heightResult.heightFt,
    heightFigure: heightResult.figure,
    footprintSf: footprint.areaSf,
    footprintFigure: footprint.figure,
    lotAreaSf,
    district,
    assumptions,
    trace,
    recordTrace: true,
    note,
    densityMultiplier: 1,
  });

  const scenarios: Scenario[] = [base];

  const affordable = statutePathway("me-4364-affordable");
  if (affordable && districtKnown && heightResult.heightFt !== null) {
    // 30-A M.R.S. s 4364: at least one storey or 14 ft above the local limit,
    // whichever the municipality's own storey height makes larger.
    const bonusFt = Math.max(14, assumptions.floorToFloorFt);
    scenarios.push(
      buildScenario({
        id: "affordable",
        label: "State affordable-housing pathway",
        premise:
          "If the project qualifies as an affordable housing development under 30-A M.R.S. §4364, the state requires the city to allow more height and density than the district alone.",
        heightFt: heightResult.heightFt + bonusFt,
        heightFigure: {
          value: heightResult.heightFt + bonusFt,
          unit: "ft",
          basis: "statute",
          citation: note(affordable.source),
          confidence: affordable.confidence,
          why: `${heightResult.heightFt} ft district limit plus the statutory bonus of one storey or 14 ft, whichever is greater (${bonusFt} ft here).`,
        },
        footprintSf: footprint.areaSf,
        footprintFigure: footprint.figure,
        lotAreaSf,
        district,
        assumptions,
        trace,
        recordTrace: false,
        note,
        densityMultiplier: affordable.densityMultiplier ?? 1,
        statuteCitation: affordable.source,
      }),
    );
  }

  // ------------------------------------------------------- statutory floor
  const fourUnit = statutePathway("me-4364-a-units");
  if (fourUnit?.minUnitsAllowed) {
    const baseUnits = base.envelope.estimatedUnits.value;
    if (baseUnits !== null && baseUnits < fourUnit.minUnitsAllowed) {
      note(fourUnit.source);
      constraints.push({
        id: "statutory-unit-floor",
        title: `State law requires at least ${fourUnit.minUnitsAllowed} units to be allowed here`,
        severity: "advisory",
        detail: `${fourUnit.description} The district's own density rules would allow only ${baseUnits}.`,
        citation: fourUnit.source,
        discretionary: false,
      });
    }
  }

  // ----------------------------------------------------------- parking note
  if (district) {
    const ratio = district.parkingSpacesPerDwelling.value;
    const units = base.envelope.estimatedUnits.value;
    if (ratio !== null && ratio > 0 && units !== null && units > 0) {
      const spaces = Math.ceil(units * ratio);
      const landSf = spaces * assumptions.surfaceParkingSfPerSpace;
      constraints.push({
        id: "parking",
        title: `Off-street parking: about ${spaces} spaces`,
        severity: "limiting",
        detail: `At ${ratio} space(s) per unit, ${units} units need roughly ${spaces} spaces. Surfaced at grade that is about ${landSf.toLocaleString()} sf of the lot — ${Math.round((landSf / Math.max(lotAreaSf, 1)) * 100)}% of it — which the footprint above does not deduct. Structured or tucked-under parking avoids the land take but costs height.`,
        citation: note(district.parkingSpacesPerDwelling.source),
        discretionary: false,
      });
    } else if (ratio === 0) {
      constraints.push({
        id: "parking-none",
        title: "No off-street parking minimum",
        severity: "advisory",
        detail:
          "Portland removed residential off-street parking minimums citywide in December 2023, so the envelope is not reduced for parking. Lenders and the market may still want spaces.",
        citation: note(district.parkingSpacesPerDwelling.source),
        discretionary: false,
      });
    }
  }

  // ------------------------------------------------- inclusionary zoning
  const iz = ruleSet.inclusionaryZoning;
  const baseUnits = base.envelope.estimatedUnits.value;
  if (baseUnits !== null && baseUnits >= iz.unitThreshold) {
    note(iz.citation);
    constraints.push({
      id: "inclusionary-zoning",
      title: `Inclusionary zoning applies at ${iz.unitThreshold} or more units`,
      severity: "advisory",
      detail: iz.summary,
      citation: iz.citation,
      discretionary: false,
    });
  }

  return {
    address: {
      query,
      matched: site.matchedAddress,
      parcelId: site.parcel.parcelId,
      matchMethod:
        site.matchMethod === "parcel-address-field"
          ? "Matched directly against the city parcel layer's address field."
          : "Geocoded, then matched to the parcel the point falls inside.",
    },
    parcel: {
      lotAreaSf: {
        value: lotAreaSf,
        unit: "sf",
        basis: "gis",
        why: "Geodesic area of the city's parcel polygon.",
      },
      geometry: site.parcel.feature.geometry,
      buildableGeometry: footprint.geometry,
    },
    zoning: {
      districtCode: site.zoning.districtCode,
      districtName: district?.name ?? site.zoning.districtName,
      districtKnown,
    },
    overlays: overlayOut,
    scenarios,
    constraints,
    assumptions: describeAssumptions(assumptions),
    trace,
    sources: site.sources,
    gaps: dedupe(gaps),
    ruleData: {
      version: ruleSet.version,
      codeEdition: ruleSet.codeEdition,
      codeEffectiveDate: ruleSet.codeEffectiveDate,
      verified: ruleSet.provenance.verifiedAgainstPrimarySource,
      warning: ruleSet.provenance.warning,
      disclaimer: ruleSet.disclaimer,
    },
    citations: [...usedCitations]
      .map((id) => findCitation(id))
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .map(({ id, document, section, title, url, edition }) => ({
        id,
        document,
        section,
        title,
        url,
        edition,
      })),
  };
}

// --------------------------------------------------------------------------

type NoteFn = (id: string | undefined) => string | undefined;

function resolveHeight(
  district: DistrictRules | null,
  site: SiteData,
  overlays: OverlayRules[],
  trace: TraceStep[],
  note: NoteFn,
): { heightFt: number | null; figure: Figure } {
  const candidates: { value: number; why: string; basis: Figure["basis"]; citation?: string }[] = [];

  // A height published on the zoning layer itself beats the transcribed table:
  // it is the city's own data for this specific polygon.
  if (site.zoning.mappedMaxHeightFt !== null && site.zoning.mappedMaxHeightFt > 0) {
    candidates.push({
      value: site.zoning.mappedMaxHeightFt,
      basis: "gis",
      why: "Maximum height published on the city's own zoning layer for this polygon.",
    });
  }

  if (district?.maxHeightFt.value !== null && district?.maxHeightFt.value !== undefined) {
    candidates.push({
      value: district.maxHeightFt.value,
      basis: "rule",
      citation: district.maxHeightFt.source,
      why: `${district.code} district maximum height.`,
    });
  }

  for (const overlay of overlays) {
    const cap = overlay.effect.maxHeightFtCap?.value;
    if (cap !== null && cap !== undefined) {
      candidates.push({
        value: cap,
        basis: "rule",
        citation: overlay.effect.maxHeightFtCap?.source,
        why: `${overlay.name} caps height below the base district.`,
      });
    }
  }

  if (candidates.length === 0) {
    const figure: Figure = {
      value: null,
      unit: "ft",
      basis: "rule",
      why: "No height limit could be established for this parcel from the available data.",
    };
    trace.push({
      id: "height",
      label: "Maximum height",
      basis: "rule",
      detail:
        "Neither the city's zoning layer nor the rule dataset gave a height limit for this district, so no height is reported.",
      result: figure,
    });
    return { heightFt: null, figure };
  }

  // The most restrictive rule governs.
  const winner = candidates.reduce((a, b) => (b.value < a.value ? b : a));
  note(winner.citation);

  const figure: Figure = {
    value: winner.value,
    unit: "ft",
    basis: winner.basis,
    citation: winner.citation,
    confidence: district?.maxHeightFt.confidence,
    why: winner.why,
  };

  trace.push({
    id: "height",
    label: "Maximum height",
    basis: winner.basis,
    citation: winner.citation,
    detail:
      candidates.length > 1
        ? `${candidates.length} height limits apply to this parcel; the most restrictive governs. ${winner.why}`
        : winner.why,
    formula:
      candidates.length > 1
        ? `min(${candidates.map((c) => `${c.value} ft`).join(", ")}) = ${winner.value} ft`
        : undefined,
    result: figure,
  });

  return { heightFt: winner.value, figure };
}

function resolveFootprint(
  district: DistrictRules | null,
  site: SiteData,
  overlays: OverlayRules[],
  lotAreaSf: number,
  trace: TraceStep[],
  constraints: Constraint[],
  gaps: string[],
  note: NoteFn,
): { areaSf: number | null; figure: Figure; geometry: unknown } {
  if (!district) {
    return {
      areaSf: null,
      figure: {
        value: null,
        unit: "sf",
        basis: "rule",
        why: "No district standards, so no setback or coverage limit could be applied.",
      },
      geometry: null,
    };
  }

  const yards: RequiredYardsFt = {
    front: district.minYardsFt.front.value ?? 0,
    side: district.minYardsFt.side.value ?? 0,
    rear: district.minYardsFt.rear.value ?? 0,
  };
  const extraSetback = overlays.reduce(
    (max, o) => Math.max(max, o.effect.additionalSetbackFt?.value ?? 0),
    0,
  );

  for (const key of ["front", "side", "rear"] as const) {
    if (district.minYardsFt[key].value === null) {
      gaps.push(`No ${key} yard is recorded for ${district.code}; it was treated as zero.`);
    }
    note(district.minYardsFt[key].source);
  }

  const setback = computeSetbackArea(site, yards, extraSetback);

  if (extraSetback > 0) {
    const source = overlays.find((o) => (o.effect.additionalSetbackFt?.value ?? 0) === extraSetback);
    note(source?.effect.additionalSetbackFt?.source);
  }

  trace.push({
    id: "setbacks",
    label: "Area left after setbacks",
    basis: "calculation",
    citation: district.minYardsFt.front.source,
    detail: setback.frontageKnown
      ? `Front ${yards.front} ft, side ${yards.side} ft, rear ${yards.rear} ft were applied to the matching lot lines; the front line was identified from the nearest street centreline.${
          extraSetback > 0 ? ` An additional ${extraSetback} ft overlay setback was applied on every line.` : ""
        }`
      : `The front lot line could not be identified, so the largest required yard (${uniformYard(
          yards,
        )} ft) was applied to every lot line. That is conservative — the real buildable area is likely larger.${
          extraSetback > 0 ? ` An additional ${extraSetback} ft overlay setback was applied as well.` : ""
        }`,
    result: {
      value: Math.round(setback.areaSf),
      unit: "sf",
      basis: "calculation",
      why: "Parcel polygon with each lot line pushed inward by its required yard.",
    },
  });

  const coverage = district.maxLotCoverageRatio.value;
  const overlayCoverage = overlays.reduce<number | null>((min, o) => {
    const cap = o.effect.maxLotCoverageRatioCap?.value ?? null;
    if (cap === null) return min;
    note(o.effect.maxLotCoverageRatioCap?.source);
    return min === null ? cap : Math.min(min, cap);
  }, null);

  const effectiveCoverage =
    coverage === null ? overlayCoverage : overlayCoverage === null ? coverage : Math.min(coverage, overlayCoverage);

  let footprintSf = setback.areaSf;
  let governedBy = "setbacks";

  if (effectiveCoverage !== null) {
    note(district.maxLotCoverageRatio.source);
    const coverageCapSf = lotAreaSf * effectiveCoverage;
    trace.push({
      id: "coverage",
      label: "Lot coverage cap",
      basis: "rule",
      citation: district.maxLotCoverageRatio.source,
      detail: `${district.code} allows structures to cover up to ${Math.round(
        effectiveCoverage * 100,
      )}% of the lot${overlayCoverage !== null && overlayCoverage === effectiveCoverage ? ", as reduced by an overlay" : ""}.`,
      formula: `${lotAreaSf.toLocaleString()} sf x ${effectiveCoverage} = ${Math.round(coverageCapSf).toLocaleString()} sf`,
      result: {
        value: Math.round(coverageCapSf),
        unit: "sf",
        basis: "rule",
        citation: district.maxLotCoverageRatio.source,
        confidence: district.maxLotCoverageRatio.confidence,
        why: "Maximum area the building may cover, from the district's lot coverage standard.",
      },
    });
    if (coverageCapSf < footprintSf) {
      footprintSf = coverageCapSf;
      governedBy = "the lot coverage cap";
    }
  } else {
    gaps.push(
      `${district.code} has no lot coverage figure in the rule dataset, so the footprint is limited only by setbacks.`,
    );
  }

  if (footprintSf <= 0) {
    constraints.push({
      id: "no-buildable-area",
      title: "Required yards consume the whole lot",
      severity: "blocking",
      detail:
        "After applying the required setbacks there is no area left to build on. Small or oddly shaped lots often need a dimensional variance.",
      citation: district.minYardsFt.front.source,
      discretionary: true,
    });
  }

  trace.push({
    id: "footprint",
    label: "Maximum footprint",
    basis: "calculation",
    detail: `The footprint is the smaller of the setback envelope and the coverage cap. Here it is governed by ${governedBy}.`,
    formula:
      effectiveCoverage !== null
        ? `min(${Math.round(setback.areaSf).toLocaleString()} sf setback envelope, ${Math.round(
            lotAreaSf * effectiveCoverage,
          ).toLocaleString()} sf coverage cap) = ${Math.round(footprintSf).toLocaleString()} sf`
        : undefined,
    result: {
      value: Math.round(footprintSf),
      unit: "sf",
      basis: "calculation",
      why: `Limited by ${governedBy}.`,
    },
  });

  return {
    areaSf: Math.round(footprintSf),
    figure: {
      value: Math.round(footprintSf),
      unit: "sf",
      basis: "calculation",
      why: `Smaller of the setback envelope and the lot coverage cap; governed by ${governedBy}.`,
    },
    // The drawn envelope is the setback polygon. When coverage governs, the
    // real building is smaller than what is drawn, and the UI says so.
    geometry: setback.geometry,
  };
}

function computeSetbackArea(
  site: SiteData,
  yards: RequiredYardsFt,
  extraSetbackFt: number,
): { areaSf: number; geometry: unknown; frontageKnown: boolean } {
  const rings = outerRingsOf(site.parcel.feature);
  if (rings.length === 0) return { areaSf: 0, geometry: null, frontageKnown: false };

  const projector = makeProjector(site.parcel.centroid);
  const streetLines = site.streetLines.map((line) => line.map((p) => projector.toFeet(p)));

  const coordinates: Position[][][] = [];
  let frontageKnown = false;

  for (const ring of rings) {
    const projected = ring.map((p) => projector.toFeet(p));
    const classes = classifyEdges(projected, streetLines);
    if (classes) frontageKnown = true;

    const perEdge = buildPerEdgeYards(projected, classes, yards, extraSetbackFt);
    const result = applySetbacks(projected, perEdge);
    for (const polygon of result.polygons) {
      coordinates.push(polygon.map((r) => r.map((p: FeetXY) => [...projector.toLonLat(p)])));
    }
  }

  if (coordinates.length === 0) {
    return { areaSf: 0, geometry: null, frontageKnown };
  }

  const geometry: MultiPolygon = { type: "MultiPolygon", coordinates };
  // Measured with the same library that measured the lot, so the footprint and
  // the lot area are always on the same basis.
  const areaSf = area(geometry) * SQ_FT_PER_SQ_M;

  return { areaSf, geometry, frontageKnown };
}

function buildPerEdgeYards(
  projectedRing: readonly FeetXY[],
  classes: ReturnType<typeof classifyEdges>,
  yards: RequiredYardsFt,
  extraSetbackFt: number,
): number[] {
  const edgeCount = Math.max(projectedRing.length - 1, 0);
  if (!classes) {
    // Without frontage information the only safe reading is the largest yard
    // on every line.
    return Array.from({ length: edgeCount }, () => uniformYard(yards) + extraSetbackFt);
  }
  return Array.from({ length: edgeCount }, (_, i) => yards[classes[i] ?? "side"] + extraSetbackFt);
}

function outerRingsOf(feature: Feature<Polygon | MultiPolygon, unknown>): LonLat[][] {
  const g = feature.geometry;
  const rings: number[][][] = g.type === "Polygon" ? [g.coordinates[0] ?? []] : g.coordinates.map((p) => p[0] ?? []);
  return rings
    .map((ring) =>
      ring.filter((p): p is [number, number] => p.length >= 2).map(([lon, lat]) => [lon, lat] as LonLat),
    )
    .filter((ring) => ring.length >= 4);
}

interface ScenarioInput {
  id: Scenario["id"];
  label: string;
  premise: string;
  heightFt: number | null;
  heightFigure: Figure;
  footprintSf: number | null;
  footprintFigure: Figure;
  lotAreaSf: number;
  district: DistrictRules | null;
  assumptions: EngineAssumptions;
  trace: TraceStep[];
  /** Only the primary scenario writes into the shared explanation trace. */
  recordTrace: boolean;
  note: NoteFn;
  densityMultiplier: number;
  statuteCitation?: string;
}

function buildScenario(input: ScenarioInput): Scenario {
  const { heightFt, footprintSf, district, assumptions, trace, note, lotAreaSf } = input;

  // ---- storeys
  const stories =
    heightFt === null
      ? null
      : Math.max(
          0,
          Math.floor((heightFt - assumptions.roofAssemblyFt) / assumptions.floorToFloorFt),
        );

  const storyLimit = district?.maxStories.value ?? null;
  const cappedStories =
    stories === null ? null : storyLimit === null ? stories : Math.min(stories, storyLimit);
  if (storyLimit !== null) note(district?.maxStories.source);

  if (input.recordTrace && heightFt !== null && stories !== null) {
    trace.push({
      id: "stories",
      label: "Approximate storeys",
      basis: "assumption",
      detail: `Height budget divided by an assumed ${assumptions.floorToFloorFt} ft floor-to-floor, after taking ${assumptions.roofAssemblyFt} ft off the top for the roof assembly. This is arithmetic, not a code limit.`,
      formula: `floor((${heightFt} ft - ${assumptions.roofAssemblyFt} ft) / ${assumptions.floorToFloorFt} ft) = ${stories}${
        cappedStories !== stories ? `, capped at ${cappedStories} by the district storey limit` : ""
      }`,
      result: {
        value: cappedStories,
        unit: "storeys",
        basis: "assumption",
        why: "Derived from the height limit and an assumed floor-to-floor height.",
      },
    });
  }

  // ---- gross floor area
  let gfa = footprintSf !== null && cappedStories !== null ? footprintSf * cappedStories : null;
  let gfaWhy = "Footprint multiplied by the number of storeys.";

  const far = district?.maxFar.value ?? null;
  if (far !== null && gfa !== null) {
    note(district?.maxFar.source);
    const farCap = lotAreaSf * far;
    if (farCap < gfa) {
      gfa = farCap;
      gfaWhy = `Limited by the district's floor area ratio of ${far}, not by footprint x storeys.`;
      if (input.recordTrace) {
        trace.push({
          id: "far",
          label: "Floor area ratio cap",
          basis: "rule",
          citation: district?.maxFar.source,
          detail: `${district?.code} caps total floor area at ${far} times the lot area, which binds before the footprint does.`,
          formula: `${lotAreaSf.toLocaleString()} sf x ${far} = ${Math.round(farCap).toLocaleString()} sf`,
          result: {
            value: Math.round(farCap),
            unit: "sf",
            basis: "rule",
            citation: district?.maxFar.source,
            why: "Maximum gross floor area from the district's FAR standard.",
          },
        });
      }
    }
  }

  if (input.recordTrace && gfa !== null && footprintSf !== null && cappedStories !== null) {
    trace.push({
      id: "gfa",
      label: "Gross floor area",
      basis: "calculation",
      detail: gfaWhy,
      formula: `${footprintSf.toLocaleString()} sf x ${cappedStories} storeys = ${(
        footprintSf * cappedStories
      ).toLocaleString()} sf`,
      result: {
        value: Math.round(gfa),
        unit: "sf",
        basis: "calculation",
        why: gfaWhy,
      },
    });
  }

  // ---- units
  const perUnit = district?.minLotAreaPerDwellingSf.value ?? null;
  const densityCap =
    perUnit !== null && perUnit > 0
      ? Math.floor((lotAreaSf / perUnit) * input.densityMultiplier)
      : null;
  if (densityCap !== null) note(district?.minLotAreaPerDwellingSf.source);

  const areaCap =
    gfa === null
      ? null
      : Math.floor((gfa * assumptions.grossToNetRatio) / assumptions.averageUnitNetSf);

  const units =
    densityCap === null && areaCap === null
      ? null
      : densityCap === null
        ? areaCap
        : areaCap === null
          ? densityCap
          : Math.min(densityCap, areaCap);

  const unitsGovernedBy =
    units === null
      ? "not determined"
      : densityCap !== null && units === densityCap
        ? "the district's land-area-per-unit density rule"
        : "the amount of floor area available";

  if (input.recordTrace && units !== null) {
    trace.push({
      id: "units",
      label: "Estimated apartments",
      basis: densityCap !== null && units === densityCap ? "rule" : "assumption",
      citation: densityCap !== null && units === densityCap ? district?.minLotAreaPerDwellingSf.source : undefined,
      detail: `Governed by ${unitsGovernedBy}. Unit counts are the softest number here — the real figure depends on the unit mix and the building's shape.`,
      formula: [
        densityCap !== null && perUnit
          ? `density: floor(${lotAreaSf.toLocaleString()} sf / ${perUnit} sf per unit${
              input.densityMultiplier !== 1 ? ` x ${input.densityMultiplier}` : ""
            }) = ${densityCap}`
          : null,
        areaCap !== null && gfa !== null
          ? `floor area: floor(${Math.round(gfa).toLocaleString()} sf x ${assumptions.grossToNetRatio} / ${assumptions.averageUnitNetSf} sf) = ${areaCap}`
          : null,
      ]
        .filter(Boolean)
        .join("   |   "),
      result: {
        value: units,
        unit: "units",
        basis: "calculation",
        why: `Smaller of the density cap and what the floor area supports.`,
      },
    });
  }

  const envelope: Envelope = {
    maxHeightFt: input.heightFigure,
    stories: {
      value: cappedStories,
      unit: "storeys",
      basis: "assumption",
      why: `${heightFt ?? "?"} ft minus ${assumptions.roofAssemblyFt} ft of roof, divided by an assumed ${assumptions.floorToFloorFt} ft floor-to-floor.`,
    },
    maxFootprintSf: input.footprintFigure,
    grossFloorAreaSf: {
      value: gfa === null ? null : Math.round(gfa),
      unit: "sf",
      basis: "calculation",
      why: gfaWhy,
    },
    estimatedUnits: {
      value: units,
      unit: "units",
      basis: densityCap !== null && units === densityCap ? "rule" : "assumption",
      citation: densityCap !== null && units === densityCap ? district?.minLotAreaPerDwellingSf.source : undefined,
      why: `Governed by ${unitsGovernedBy}.`,
    },
  };

  return {
    id: input.id,
    label: input.label,
    premise: input.premise,
    envelope,
    statuteCitation: input.statuteCitation,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
