/**
 * The standards the calculator actually applies to a parcel.
 *
 * A parcel's district may be in the rule dataset, may be in it with blanks,
 * or may not be in it at all — and the zoning layer may have returned
 * nothing. The tool's job is still to estimate. So every standard here has a
 * value, always, and each one records whether it came from the district's own
 * table (a rule) or from the family defaults (an assumption). The page shows
 * that distinction on every figure, and the trace names each estimated field.
 */
import {
  familyDefaults,
  findDistrictLoose,
  inferFamily,
  ruleSet,
} from "../rules/load";
import type { DistrictFamily, DistrictRules, FamilyDefaults } from "../rules/schema";
import type { SiteData } from "../gis/site";
import type { Basis } from "./types";

export interface Std<T> {
  value: T;
  basis: Extract<Basis, "rule" | "assumption">;
  /** Citation id. */
  source: string;
  note?: string;
}

export interface EffectiveStandards {
  /** The district's code as the GIS reported it, if it reported one. */
  districtCode: string | null;
  /** The matched district, when the dataset holds it. */
  district: DistrictRules | null;
  family: DistrictFamily;
  defaults: FamilyDefaults;
  /** True when the district itself had to be estimated, not just a field. */
  districtEstimated: boolean;
  /** Names of fields filled from family defaults. Empty when fully by rule. */
  estimatedFields: string[];

  multifamilyAllowed: Std<boolean>;
  maxHeightFt: Std<number>;
  /** Only ever a rule; a default never caps storeys. */
  maxStories: number | null;
  maxLotCoverageRatio: Std<number>;
  minYardsFt: { front: Std<number>; side: Std<number>; rear: Std<number> };
  /** null means "no land-area density cap", which is itself a legitimate rule. */
  minLotAreaPerDwellingSf: Std<number | null>;
  /** Only ever a rule. */
  maxFar: number | null;
  parkingSpacesPerDwelling: number | null;
  parkingSource: string | null;
}

export function buildStandards(site: SiteData): EffectiveStandards {
  const district = findDistrictLoose(
    site.zoning.districtCode,
    site.zoning.districtName,
    site.zoning.rawValues,
  );
  const family: DistrictFamily = district
    ? district.category
    : inferFamily(site.zoning.districtCode, site.zoning.districtName);
  const defaults = familyDefaults(family);
  const estimatedFields: string[] = [];
  const estimateSource = ruleSet.estimateDefaults.citation;

  function pick<T>(
    label: string,
    ruleValue: T | null | undefined,
    ruleSource: string | undefined,
    fallback: T,
    ruleNote?: string,
  ): Std<T> {
    if (ruleValue !== null && ruleValue !== undefined && ruleSource) {
      return { value: ruleValue, basis: "rule", source: ruleSource, note: ruleNote };
    }
    estimatedFields.push(label);
    return {
      value: fallback,
      basis: "assumption",
      source: estimateSource,
      note: `No ${label} standard was available for this district; the ${family} family default was used.`,
    };
  }

  const yards = district?.minYardsFt;

  return {
    districtCode: site.zoning.districtCode,
    district,
    family,
    defaults,
    districtEstimated: district === null,
    estimatedFields,

    multifamilyAllowed: pick(
      "multifamily use",
      district?.multifamilyAllowed.value,
      district?.multifamilyAllowed.source,
      defaults.multifamilyAllowed,
    ),
    maxHeightFt: pick(
      "maximum height",
      district?.maxHeightFt.value,
      district?.maxHeightFt.source,
      defaults.maxHeightFt,
      district?.maxHeightFt.note,
    ),
    maxStories: district?.maxStories.value ?? defaults.maxStories,
    maxLotCoverageRatio: pick(
      "lot coverage",
      district?.maxLotCoverageRatio.value,
      district?.maxLotCoverageRatio.source,
      defaults.maxLotCoverageRatio,
    ),
    minYardsFt: {
      front: pick("front yard", yards?.front.value, yards?.front.source, defaults.minYardsFt.front),
      side: pick("side yard", yards?.side.value, yards?.side.source, defaults.minYardsFt.side),
      rear: pick("rear yard", yards?.rear.value, yards?.rear.source, defaults.minYardsFt.rear),
    },
    // A district that is in the dataset and states no density cap really has
    // none (downtown, for instance). Only an unknown district borrows one.
    minLotAreaPerDwellingSf: district
      ? {
          value: district.minLotAreaPerDwellingSf.value,
          basis: "rule",
          source: district.minLotAreaPerDwellingSf.source,
          note: district.minLotAreaPerDwellingSf.note,
        }
      : pick("density", null, undefined, defaults.minLotAreaPerDwellingSf),
    maxFar: district?.maxFar.value ?? null,
    parkingSpacesPerDwelling: district?.parkingSpacesPerDwelling.value ?? null,
    parkingSource: district?.parkingSpacesPerDwelling.source ?? null,
  };
}

/** One sentence for the page explaining where the standards came from. */
export function describeStandards(s: EffectiveStandards): string {
  if (!s.districtEstimated && s.estimatedFields.length === 0) {
    return `What ${s.district!.code} allows by right, before any bonus or discretionary approval.`;
  }
  if (s.districtEstimated) {
    const seen = s.districtCode ? `The city's zoning layer reports "${s.districtCode}", which is not in this app's rule dataset` : "No zoning district could be read for this parcel";
    return `${seen}, so this is an estimate using typical ${s.family} standards. ${s.defaults.rationale}`;
  }
  return `What ${s.district!.code} allows by right, with ${s.estimatedFields.join(", ")} estimated from ${s.family} family defaults because the district table leaves them blank.`;
}
