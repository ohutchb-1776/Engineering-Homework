/**
 * The calculation.
 *
 * Deterministic, ordered, and traced. Each step records what it used and why,
 * so the page can show the derivation rather than a bare number.
 *
 * It always produces an estimate. When a parcel's own standard is missing —
 * the district is not in the dataset, the zoning layer returned nothing, or
 * the table leaves a value blank — the family default from the dataset is
 * used, the figure is labelled "our assumption", and the trace names exactly
 * which fields were estimated. What it never does is present an estimate as
 * a rule.
 */
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import area from "@turf/area";
import { makeProjector, type FeetXY, type LonLat } from "../geometry/project";
import { applySetbacks, classifyEdges, uniformYard, type RequiredYardsFt } from "../geometry/setbacks";
import { findCitation, findOverlay, ruleSet, statutePathway } from "../rules/load";
import type { OverlayRules } from "../rules/schema";
import { SQ_FT_PER_SQ_M, type SiteData } from "../gis/site";
import { DEFAULT_ASSUMPTIONS, describeAssumptions, type EngineAssumptions } from "./assumptions";
import { buildStandards, describeStandards, type EffectiveStandards } from "./standards";
import type { AnalysisResult, Constraint, Envelope, Figure, Scenario, TraceStep } from "./types";

type NoteFn = (id: string | undefined) => string | undefined;

export function analyze(
  site: SiteData,
  query: string,
  assumptions: EngineAssumptions = DEFAULT_ASSUMPTIONS,
): AnalysisResult {
  const trace: TraceStep[] = [];
  const constraints: Constraint[] = [];
  const gaps = [...site.gaps];
  const usedCitations = new Set<string>();
  const note: NoteFn = (id) => {
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
  const standards = buildStandards(site);
  const { district } = standards;

  if (district) {
    trace.push({
      id: "district",
      label: "Zoning district",
      basis: "gis",
      detail: `The parcel falls in ${district.code} (${district.name}), read from the city's zoning layer${
        site.zoning.method === "nearest" ? " as the nearest district polygon" : ""
      }.`,
      result: { value: null, unit: "district", text: district.code, basis: "gis", why: "City of Portland zoning district polygons." },
    });
  } else {
    note(ruleSet.estimateDefaults.citation);
    trace.push({
      id: "district",
      label: "Zoning district",
      basis: "assumption",
      citation: ruleSet.estimateDefaults.citation,
      detail: site.zoning.districtCode
        ? `The zoning layer reports "${site.zoning.districtCode}"${
            site.zoning.districtName ? ` (${site.zoning.districtName})` : ""
          }, which is not in this app's rule dataset. Its code puts it in the ${standards.family} family, whose typical standards are used below as an estimate.`
        : `No district could be read from the zoning layer, so typical ${standards.family} standards are used below as an estimate.`,
      result: {
        value: null,
        unit: "district",
        text: site.zoning.districtCode ?? `${standards.family} (estimated)`,
        basis: "assumption",
        why: standards.defaults.rationale,
      },
    });
    constraints.push({
      id: "district-estimated",
      title: site.zoning.districtCode
        ? `District "${site.zoning.districtCode}" is not in the rule dataset — figures are estimates`
        : "No zoning district could be read — figures are estimates",
      severity: "limiting",
      detail: `${standards.defaults.rationale} To replace the estimate with the district's actual standards, add "${
        site.zoning.districtCode ?? "the district"
      }" to data/rules/portland-me.json.`,
      citation: ruleSet.estimateDefaults.citation,
      discretionary: false,
    });
  }

  if (district && standards.estimatedFields.length > 0) {
    note(ruleSet.estimateDefaults.citation);
    constraints.push({
      id: "fields-estimated",
      title: `${district.code}: ${standards.estimatedFields.join(", ")} estimated`,
      severity: "advisory",
      detail: `The rule table for ${district.code} leaves these blank, so typical ${standards.family} values were used for them. Everything else is the district's own standard.`,
      citation: ruleSet.estimateDefaults.citation,
      discretionary: false,
    });
  }

  if (standards.multifamilyAllowed.value === false) {
    note(standards.multifamilyAllowed.source);
    constraints.push({
      id: "multifamily-not-allowed",
      title: `Apartments are not a base permitted use in ${district?.code ?? "this district"}`,
      severity: "blocking",
      detail:
        "The envelope below is hypothetical: it is what the dimensional standards would allow if housing were permitted. State law still requires at least 3-4 units per lot wherever residential use is allowed, and residential use in commercially zoned areas — see the statewide pathways.",
      citation: standards.multifamilyAllowed.source,
      discretionary: false,
    });
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
  const height = resolveHeight(standards, site, overlayRules, trace, note);

  // ------------------------------------------------------------- footprint
  const footprint = resolveFootprint(standards, site, overlayRules, lotAreaSf, trace, constraints, gaps, note);

  // ------------------------------------------------------------- scenarios
  const base = buildScenario({
    id: "base",
    label: standards.districtEstimated ? "Estimated base zoning" : "Base zoning",
    premise: describeStandards(standards),
    heightFt: height.heightFt,
    heightFigure: height.figure,
    footprintSf: footprint.areaSf,
    footprintFigure: footprint.figure,
    lotAreaSf,
    standards,
    assumptions,
    trace,
    recordTrace: true,
    note,
    densityMultiplier: 1,
  });
  const scenarios: Scenario[] = [base];

  // The community-need pathway: what state law obliges the city to allow for
  // an affordable development. Always offered, never folded into the base.
  const affordable = statutePathway("me-4364-affordable");
  if (affordable) {
    const bonusFt = Math.max(14, assumptions.floorToFloorFt);
    scenarios.push(
      buildScenario({
        id: "affordable",
        label: "Community-need pathway: affordable housing under state law",
        premise:
          "If the project qualifies as an affordable housing development under 30-A M.R.S. §4364, the state requires the city to allow at least one storey or 14 ft more height and 2.5x the base density, with no more than 2 parking spaces per 3 units.",
        heightFt: height.heightFt + bonusFt,
        heightFigure: {
          value: height.heightFt + bonusFt,
          unit: "ft",
          basis: "statute",
          citation: note(affordable.source),
          confidence: affordable.confidence,
          why: `${height.heightFt} ft base limit plus the statutory bonus of one storey or 14 ft, whichever is greater (${bonusFt} ft here).`,
        },
        footprintSf: footprint.areaSf,
        footprintFigure: footprint.figure,
        lotAreaSf,
        standards,
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
  const baseUnits = base.envelope.estimatedUnits.value;
  if (fourUnit?.minUnitsAllowed && baseUnits !== null && baseUnits < fourUnit.minUnitsAllowed) {
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

  // ----------------------------------------------------------- parking note
  const ratio = standards.parkingSpacesPerDwelling;
  if (ratio !== null && ratio > 0 && baseUnits !== null && baseUnits > 0) {
    const spaces = Math.ceil(baseUnits * ratio);
    const landSf = spaces * assumptions.surfaceParkingSfPerSpace;
    constraints.push({
      id: "parking",
      title: `Off-street parking: about ${spaces} spaces`,
      severity: "limiting",
      detail: `At ${ratio} space(s) per unit, ${baseUnits} units need roughly ${spaces} spaces. Surfaced at grade that is about ${landSf.toLocaleString()} sf of the lot — ${Math.round((landSf / Math.max(lotAreaSf, 1)) * 100)}% of it — which the footprint above does not deduct. Structured or tucked-under parking avoids the land take but costs height.`,
      citation: note(standards.parkingSource ?? undefined),
      discretionary: false,
    });
  } else if (ratio === 0) {
    constraints.push({
      id: "parking-none",
      title: "No off-street parking minimum",
      severity: "advisory",
      detail:
        "Portland removed residential off-street parking minimums citywide in December 2023, so the envelope is not reduced for parking. Lenders and the market may still want spaces.",
      citation: note(standards.parkingSource ?? undefined),
      discretionary: false,
    });
  }

  // ------------------------------------------------- inclusionary zoning
  const iz = ruleSet.inclusionaryZoning;
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
      matchMethod: MATCH_METHOD_TEXT[site.matchMethod],
    },
    parcel: {
      lotAreaSf: { value: lotAreaSf, unit: "sf", basis: "gis", why: "Geodesic area of the city's parcel polygon." },
      geometry: site.parcel.feature.geometry,
      buildableGeometry: footprint.geometry,
    },
    zoning: {
      districtCode: site.zoning.districtCode,
      districtName: district?.name ?? site.zoning.districtName,
      districtKnown: district !== null,
      family: standards.family,
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
      .map(({ id, document, section, title, url, edition }) => ({ id, document, section, title, url, edition })),
  };
}

const MATCH_METHOD_TEXT: Record<SiteData["matchMethod"], string> = {
  "parcel-address-field": "Matched directly against the city parcel layer's address field.",
  "geocode-point-in-parcel": "Geocoded, then matched to the parcel the point falls inside.",
  "geocode-nearest-parcel":
    "Geocoded to a point outside every parcel, then matched to the nearest one. Confirm it is the right lot.",
};

// --------------------------------------------------------------------------

function resolveHeight(
  standards: EffectiveStandards,
  site: SiteData,
  overlays: OverlayRules[],
  trace: TraceStep[],
  note: NoteFn,
): { heightFt: number; figure: Figure } {
  const candidates: { value: number; why: string; basis: Figure["basis"]; citation?: string }[] = [];

  // A height published on the zoning layer itself beats any table: it is the
  // city's own data for this specific polygon.
  if (site.zoning.mappedMaxHeightFt !== null && site.zoning.mappedMaxHeightFt > 0) {
    candidates.push({
      value: site.zoning.mappedMaxHeightFt,
      basis: "gis",
      why: "Maximum height published on the city's own zoning layer for this polygon.",
    });
  }

  candidates.push({
    value: standards.maxHeightFt.value,
    basis: standards.maxHeightFt.basis,
    citation: standards.maxHeightFt.source,
    why:
      standards.maxHeightFt.basis === "rule"
        ? `${standards.district!.code} district maximum height.`
        : `Typical ${standards.family} height limit, used as an estimate because no district standard was available.`,
  });

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

  // The most restrictive governs.
  const winner = candidates.reduce((a, b) => (b.value < a.value ? b : a));
  note(winner.citation);

  const figure: Figure = {
    value: winner.value,
    unit: "ft",
    basis: winner.basis,
    citation: winner.citation,
    confidence: standards.district?.maxHeightFt.confidence,
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
  standards: EffectiveStandards,
  site: SiteData,
  overlays: OverlayRules[],
  lotAreaSf: number,
  trace: TraceStep[],
  constraints: Constraint[],
  gaps: string[],
  note: NoteFn,
): { areaSf: number; figure: Figure; geometry: unknown } {
  const y = standards.minYardsFt;
  const yards: RequiredYardsFt = { front: y.front.value, side: y.side.value, rear: y.rear.value };
  const yardsEstimated = [y.front, y.side, y.rear].some((v) => v.basis === "assumption");
  const yardBasis: Figure["basis"] = yardsEstimated ? "assumption" : "rule";
  for (const v of [y.front, y.side, y.rear]) note(v.source);

  const extraSetback = overlays.reduce((max, o) => Math.max(max, o.effect.additionalSetbackFt?.value ?? 0), 0);
  if (extraSetback > 0) {
    const source = overlays.find((o) => (o.effect.additionalSetbackFt?.value ?? 0) === extraSetback);
    note(source?.effect.additionalSetbackFt?.source);
  }

  const setback = computeSetbackArea(site, yards, extraSetback);
  const label = standards.district?.code ?? `the ${standards.family} family`;

  trace.push({
    id: "setbacks",
    label: "Area left after setbacks",
    basis: yardBasis,
    citation: y.front.source,
    detail: `${setback.frontageKnown
      ? `Front ${yards.front} ft, side ${yards.side} ft, rear ${yards.rear} ft were applied to the matching lot lines; the front line was identified from the nearest street centreline.`
      : `The front lot line could not be identified, so the largest required yard (${uniformYard(yards)} ft) was applied to every lot line. That is conservative — the real buildable area is likely larger.`}${
      extraSetback > 0 ? ` An additional ${extraSetback} ft overlay setback was applied on every line.` : ""
    }${yardsEstimated ? ` Yards are typical values for ${label}, not the district's own standard.` : ""}`,
    result: {
      value: Math.round(setback.areaSf),
      unit: "sf",
      basis: "calculation",
      why: "Parcel polygon with each lot line pushed inward by its required yard.",
    },
  });

  const overlayCoverage = overlays.reduce<number | null>((min, o) => {
    const cap = o.effect.maxLotCoverageRatioCap?.value ?? null;
    if (cap === null) return min;
    note(o.effect.maxLotCoverageRatioCap?.source);
    return min === null ? cap : Math.min(min, cap);
  }, null);
  const coverage = standards.maxLotCoverageRatio;
  note(coverage.source);
  const effectiveCoverage = overlayCoverage === null ? coverage.value : Math.min(coverage.value, overlayCoverage);
  const coverageCapSf = lotAreaSf * effectiveCoverage;

  trace.push({
    id: "coverage",
    label: "Lot coverage cap",
    basis: coverage.basis,
    citation: coverage.source,
    detail: `${coverage.basis === "rule" ? standards.district!.code + " allows" : `Typical ${standards.family} districts allow`} structures to cover up to ${Math.round(
      effectiveCoverage * 100,
    )}% of the lot${overlayCoverage !== null && overlayCoverage === effectiveCoverage ? ", as reduced by an overlay" : ""}.`,
    formula: `${lotAreaSf.toLocaleString()} sf x ${effectiveCoverage} = ${Math.round(coverageCapSf).toLocaleString()} sf`,
    result: {
      value: Math.round(coverageCapSf),
      unit: "sf",
      basis: coverage.basis,
      citation: coverage.source,
      why: "Maximum area the building may cover.",
    },
  });

  let footprintSf = setback.areaSf;
  let governedBy = "setbacks";
  if (coverageCapSf < footprintSf) {
    footprintSf = coverageCapSf;
    governedBy = "the lot coverage cap";
  }

  if (footprintSf <= 0) {
    constraints.push({
      id: "no-buildable-area",
      title: "Required yards consume the whole lot",
      severity: "blocking",
      detail:
        "After applying the required setbacks there is no area left to build on. Small or oddly shaped lots often need a dimensional variance; the storey and unit figures below assume one is granted for a minimal footprint.",
      citation: y.front.source,
      discretionary: true,
    });
    // Still estimate something: a lot this tight would be built to its
    // coverage cap under a variance, which is what the number reports.
    footprintSf = Math.max(coverageCapSf, 0);
    governedBy = "the lot coverage cap, assuming a setback variance";
    gaps.push("The setback envelope is zero; the footprint shown assumes a variance and uses the coverage cap instead.");
  }

  trace.push({
    id: "footprint",
    label: "Maximum footprint",
    basis: "calculation",
    detail: `The footprint is the smaller of the setback envelope and the coverage cap. Here it is governed by ${governedBy}.`,
    formula: `min(${Math.round(setback.areaSf).toLocaleString()} sf setback envelope, ${Math.round(coverageCapSf).toLocaleString()} sf coverage cap) = ${Math.round(footprintSf).toLocaleString()} sf`,
    result: { value: Math.round(footprintSf), unit: "sf", basis: "calculation", why: `Limited by ${governedBy}.` },
  });

  return {
    areaSf: Math.round(footprintSf),
    figure: {
      value: Math.round(footprintSf),
      unit: "sf",
      basis: "calculation",
      why: `Smaller of the setback envelope and the lot coverage cap; governed by ${governedBy}.`,
    },
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
  heightFt: number;
  heightFigure: Figure;
  footprintSf: number;
  footprintFigure: Figure;
  lotAreaSf: number;
  standards: EffectiveStandards;
  assumptions: EngineAssumptions;
  trace: TraceStep[];
  /** Only the primary scenario writes into the shared explanation trace. */
  recordTrace: boolean;
  note: NoteFn;
  densityMultiplier: number;
  statuteCitation?: string;
}

function buildScenario(input: ScenarioInput): Scenario {
  const { heightFt, footprintSf, standards, assumptions, trace, note, lotAreaSf } = input;

  // ---- storeys
  const rawStories = Math.max(1, Math.floor((heightFt - assumptions.roofAssemblyFt) / assumptions.floorToFloorFt));
  const storyLimit = standards.maxStories;
  const stories = storyLimit === null ? rawStories : Math.min(rawStories, storyLimit);
  if (storyLimit !== null) note(standards.district?.maxStories.source);

  if (input.recordTrace) {
    trace.push({
      id: "stories",
      label: "Approximate storeys",
      basis: "assumption",
      detail: `Height budget divided by an assumed ${assumptions.floorToFloorFt} ft floor-to-floor, after taking ${assumptions.roofAssemblyFt} ft off the top for the roof assembly. This is arithmetic, not a code limit.`,
      formula: `floor((${heightFt} ft - ${assumptions.roofAssemblyFt} ft) / ${assumptions.floorToFloorFt} ft) = ${rawStories}${
        stories !== rawStories ? `, capped at ${stories} by the district storey limit` : ""
      }`,
      result: { value: stories, unit: "storeys", basis: "assumption", why: "Derived from the height limit and an assumed floor-to-floor height." },
    });
  }

  // ---- gross floor area
  let gfa = footprintSf * stories;
  let gfaWhy = "Footprint multiplied by the number of storeys.";
  const far = standards.maxFar;
  if (far !== null) {
    note(standards.district?.maxFar.source);
    const farCap = lotAreaSf * far;
    if (farCap < gfa) {
      gfa = farCap;
      gfaWhy = `Limited by the district's floor area ratio of ${far}, not by footprint x storeys.`;
      if (input.recordTrace) {
        trace.push({
          id: "far",
          label: "Floor area ratio cap",
          basis: "rule",
          citation: standards.district?.maxFar.source,
          detail: `${standards.district?.code} caps total floor area at ${far} times the lot area, which binds before the footprint does.`,
          formula: `${lotAreaSf.toLocaleString()} sf x ${far} = ${Math.round(farCap).toLocaleString()} sf`,
          result: { value: Math.round(farCap), unit: "sf", basis: "rule", citation: standards.district?.maxFar.source, why: "Maximum gross floor area from the district's FAR standard." },
        });
      }
    }
  }

  if (input.recordTrace) {
    trace.push({
      id: "gfa",
      label: "Gross floor area",
      basis: "calculation",
      detail: gfaWhy,
      formula: `${footprintSf.toLocaleString()} sf x ${stories} storeys = ${(footprintSf * stories).toLocaleString()} sf`,
      result: { value: Math.round(gfa), unit: "sf", basis: "calculation", why: gfaWhy },
    });
  }

  // ---- units
  const perUnit = standards.minLotAreaPerDwellingSf.value;
  const densityCap = perUnit !== null && perUnit > 0 ? Math.floor((lotAreaSf / perUnit) * input.densityMultiplier) : null;
  if (densityCap !== null) note(standards.minLotAreaPerDwellingSf.source);
  const areaCap = Math.floor((gfa * assumptions.grossToNetRatio) / assumptions.averageUnitNetSf);
  const units = Math.max(0, densityCap === null ? areaCap : Math.min(densityCap, areaCap));
  const densityGoverns = densityCap !== null && units === densityCap && densityCap <= areaCap;
  const unitsBasis: Figure["basis"] = densityGoverns ? standards.minLotAreaPerDwellingSf.basis : "assumption";
  const unitsGovernedBy = densityGoverns
    ? standards.minLotAreaPerDwellingSf.basis === "rule"
      ? "the district's land-area-per-unit density rule"
      : `a typical ${standards.family} land-area-per-unit density (estimated)`
    : "the amount of floor area available";

  if (input.recordTrace) {
    trace.push({
      id: "units",
      label: "Estimated apartments",
      basis: unitsBasis,
      citation: densityGoverns ? standards.minLotAreaPerDwellingSf.source : undefined,
      detail: `Governed by ${unitsGovernedBy}. Unit counts are the softest number here — the real figure depends on the unit mix and the building's shape.`,
      formula: [
        densityCap !== null && perUnit
          ? `density: floor(${lotAreaSf.toLocaleString()} sf / ${perUnit} sf per unit${input.densityMultiplier !== 1 ? ` x ${input.densityMultiplier}` : ""}) = ${densityCap}`
          : null,
        `floor area: floor(${Math.round(gfa).toLocaleString()} sf x ${assumptions.grossToNetRatio} / ${assumptions.averageUnitNetSf} sf) = ${areaCap}`,
      ].filter(Boolean).join("   |   "),
      result: { value: units, unit: "units", basis: "calculation", why: "Smaller of the density cap and what the floor area supports." },
    });
  }

  const envelope: Envelope = {
    maxHeightFt: input.heightFigure,
    stories: {
      value: stories,
      unit: "storeys",
      basis: "assumption",
      why: `${heightFt} ft minus ${assumptions.roofAssemblyFt} ft of roof, divided by an assumed ${assumptions.floorToFloorFt} ft floor-to-floor.`,
    },
    maxFootprintSf: input.footprintFigure,
    grossFloorAreaSf: { value: Math.round(gfa), unit: "sf", basis: "calculation", why: gfaWhy },
    estimatedUnits: {
      value: units,
      unit: "units",
      basis: unitsBasis,
      citation: densityGoverns ? standards.minLotAreaPerDwellingSf.source : undefined,
      why: `Governed by ${unitsGovernedBy}.`,
    },
  };

  return { id: input.id, label: input.label, premise: input.premise, envelope, statuteCitation: input.statuteCitation };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
