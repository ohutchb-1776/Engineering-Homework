/**
 * Loading and indexing the rule dataset.
 *
 * District codes arrive from the GIS in whatever shape the city's map uses
 * ("R-6", "R6", "r-6 "), so lookups normalise before comparing. A code we
 * don't hold is a miss, never a fallback to a "typical" district.
 */
import raw from "../../../data/rules/portland-me.json";
import type {
  Citation,
  DistrictFamily,
  DistrictRules,
  FamilyDefaults,
  OverlayRules,
  RuleSet,
  StatutePathway,
} from "./schema";

export const ruleSet = raw as unknown as RuleSet;

/** "R-6", "r6", " R 6 " -> "R6". */
export function normalizeDistrictCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const districtIndex = new Map<string, DistrictRules>(
  ruleSet.districts.map((d) => [normalizeDistrictCode(d.code), d]),
);
const overlayIndex = new Map<string, OverlayRules>(ruleSet.overlays.map((o) => [o.id, o]));
const citationIndex = new Map<string, Citation>(ruleSet.citations.map((c) => [c.id, c]));

export function findDistrict(code: string | null | undefined): DistrictRules | null {
  if (!code) return null;
  return districtIndex.get(normalizeDistrictCode(code)) ?? null;
}

const districtByName = new Map<string, DistrictRules>(
  ruleSet.districts.map((d) => [normalizeDistrictCode(d.name), d]),
);

/**
 * A looser lookup for when the GIS does not hand us a clean code: try the
 * code, then the district's printed name, then every string the zoning
 * polygon carried. Still returns null rather than a "similar" district —
 * the family-default path handles that case, and labels it.
 */
export function findDistrictLoose(
  code: string | null | undefined,
  name: string | null | undefined,
  rawValues: readonly string[] = [],
): DistrictRules | null {
  const byCode = findDistrict(code);
  if (byCode) return byCode;
  if (name) {
    const byName = districtByName.get(normalizeDistrictCode(name));
    if (byName) return byName;
    const byNameAsCode = findDistrict(name);
    if (byNameAsCode) return byNameAsCode;
  }
  for (const value of rawValues) {
    const hit = findDistrict(value) ?? districtByName.get(normalizeDistrictCode(value));
    if (hit) return hit;
  }
  return null;
}

/**
 * Which family a district code belongs to, from Portland's naming pattern:
 * R-* residential, IR-* island residential, B-* business, I-* industrial,
 * and so on. Used only to choose estimating defaults for a district the
 * dataset does not hold.
 */
export function inferFamily(code: string | null | undefined, name?: string | null): DistrictFamily {
  const text = `${code ?? ""} ${name ?? ""}`.toUpperCase();
  const normalized = normalizeDistrictCode(code ?? "");
  if (/^IR|ISLAND/.test(normalized) || /ISLAND/.test(text)) return "island";
  if (/^(ROS|RP|OS|P)\b/.test(normalized) || /OPEN SPACE|RESOURCE PROTECTION|RECREATION|CONSERVATION/.test(text)) {
    return "other";
  }
  if (/^R\d|^R$|RESIDEN/.test(normalized) || /RESIDENTIAL/.test(text)) return "residential";
  if (/^I[A-Z]?\d*$|^IB|^IM|^IH|^IL|INDUSTR/.test(normalized) || /INDUSTRIAL/.test(text)) return "industrial";
  if (/MIXED|^MU|^B\d?[A-Z]?$|^C\d/.test(normalized) || /MIXED/.test(text)) {
    return /MIXED|^MU/.test(normalized) || /MIXED/.test(text) ? "mixed-use" : "business";
  }
  if (/^B|^OP|^C|BUSINESS|COMMERC|OFFICE|DOWNTOWN/.test(normalized) || /BUSINESS|COMMERCIAL|OFFICE|DOWNTOWN/.test(text)) {
    return "business";
  }
  if (/INSTITUT|CAMPUS|^IN|HOSPITAL|UNIVERSITY/.test(text)) return "institutional";
  return "unknown";
}

export function familyDefaults(family: DistrictFamily): FamilyDefaults {
  return ruleSet.estimateDefaults.families[family] ?? ruleSet.estimateDefaults.families.unknown;
}

export function findOverlay(id: string | null | undefined): OverlayRules | null {
  if (!id) return null;
  return overlayIndex.get(id) ?? null;
}

export function findCitation(id: string | null | undefined): Citation | null {
  if (!id) return null;
  return citationIndex.get(id) ?? null;
}

export function allDistrictCodes(): string[] {
  return ruleSet.districts.map((d) => d.code);
}

export function statutePathway(id: string): StatutePathway | null {
  return ruleSet.statutePathways.find((p) => p.id === id) ?? null;
}
