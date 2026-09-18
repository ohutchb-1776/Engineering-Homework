/**
 * Loading and indexing the rule dataset.
 *
 * District codes arrive from the GIS in whatever shape the city's map uses
 * ("R-6", "R6", "r-6 "), so lookups normalise before comparing. A code we
 * don't hold is a miss, never a fallback to a "typical" district.
 */
import raw from "../../../data/rules/portland-me.json";
import type { Citation, DistrictRules, OverlayRules, RuleSet, StatutePathway } from "./schema";

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
