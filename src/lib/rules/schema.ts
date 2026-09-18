/**
 * Types for the versioned Portland, Maine zoning rule dataset.
 *
 * Design rule for this whole file: **no bare numbers**. Every value the
 * calculator can put in front of a user carries the citation it came from and
 * how much we trust it. If a value is missing we store `null` and say so —
 * we never substitute a plausible-looking default, because a plausible
 * -looking default is indistinguishable from a real rule once it reaches the
 * screen.
 */

/** How much the project trusts a single value. */
export type Confidence =
  /** Transcribed from the cited primary source and checked against it. */
  | "verified"
  /** Transcribed, but not yet checked against the primary source. */
  | "needs-verification"
  /** The source does not state a value, or states it conditionally. */
  | "not-stated";

/** A pointer to the primary source a value was transcribed from. */
export interface Citation {
  /** Stable id referenced by `Sourced.source`. */
  id: string;
  /** e.g. "City of Portland, ME Code of Ordinances, ch. 14 (Land Use)". */
  document: string;
  /** e.g. "Sec. 14-139" or "Table 14-2". */
  section: string;
  /** Human label for the section. */
  title?: string;
  url: string;
  /** Which edition/amendment of the document this refers to. */
  edition: string;
  /** ISO date the citation was last looked at by a maintainer. */
  checked: string | null;
}

/** A value plus where it came from. */
export interface Sourced<T> {
  value: T | null;
  /** Citation id. */
  source: string;
  confidence: Confidence;
  /** Caveats, conditions, "except when..." text from the source. */
  note?: string;
}

export type DistrictCategory =
  | "residential"
  | "mixed-use"
  | "business"
  | "industrial"
  | "institutional"
  | "island"
  | "other";

/** Dimensional standards for one base zoning district. */
export interface DistrictRules {
  /** District code exactly as it appears on the city zoning map, e.g. "R-6". */
  code: string;
  name: string;
  category: DistrictCategory;
  /** Whether multi-unit residential is a permitted use in the district. */
  multifamilyAllowed: Sourced<boolean>;
  maxHeightFt: Sourced<number>;
  /** Some districts cap stories independently of feet. */
  maxStories: Sourced<number>;
  minLotAreaSf: Sourced<number>;
  /** Density control: land area required per dwelling unit. */
  minLotAreaPerDwellingSf: Sourced<number>;
  /** Floor area ratio cap, if the district uses one. */
  maxFar: Sourced<number>;
  /** 0–1. Share of the lot that structures may cover. */
  maxLotCoverageRatio: Sourced<number>;
  minYardsFt: {
    front: Sourced<number>;
    side: Sourced<number>;
    rear: Sourced<number>;
  };
  minStreetFrontageFt: Sourced<number>;
  /** Off-street parking required per dwelling unit. */
  parkingSpacesPerDwelling: Sourced<number>;
  notes?: string[];
}

export type OverlayEffectKind =
  /** Lowers the allowed height. */
  | "height-cap"
  /** Lowers allowed lot coverage. */
  | "coverage-cap"
  /** Pushes the buildable area further inward. */
  | "setback"
  /** Adds a discretionary review step but no hard dimensional number. */
  | "review"
  /** Worth telling the user about; no calculable effect. */
  | "informational";

/** A mapped overlay, and what it does to the envelope if anything. */
export interface OverlayRules {
  /** Stable id used by the GIS layer mapping. */
  id: string;
  name: string;
  kind: OverlayEffectKind;
  /** Plain-language description shown in the UI. */
  description: string;
  /** Citation id for the overlay's authority. Required even when it has no numbers. */
  citation: string;
  effect: {
    maxHeightFtCap?: Sourced<number>;
    maxLotCoverageRatioCap?: Sourced<number>;
    additionalSetbackFt?: Sourced<number>;
  };
  /**
   * True when the overlay means a human body (planning board, historic
   * preservation board, DEP) decides the outcome. The calculator can never
   * predict these, so it reports them as constraints, not as numbers.
   */
  triggersDiscretionaryReview: boolean;
}

/**
 * A statewide statute that can permit more than the local district does.
 * Reported as a separate, clearly-labelled scenario — never folded silently
 * into the base result.
 */
export interface StatutePathway {
  id: string;
  name: string;
  description: string;
  source: string;
  confidence: Confidence;
  /** Minimum units the statute requires be allowed, regardless of density. */
  minUnitsAllowed?: number;
  /** Multiplier on the district's allowed density, e.g. 2.5 for affordable. */
  densityMultiplier?: number;
  conditions: string[];
}

/**
 * How the dataset was produced. This is rendered in the UI verbatim; it is the
 * difference between "a tool that cites the code" and "a tool that looks like
 * it cites the code".
 */
export interface Provenance {
  /** How the values got into the file. */
  method: string;
  /** True only once a maintainer has checked values against the primary source. */
  verifiedAgainstPrimarySource: boolean;
  /** Shown to every user while `verifiedAgainstPrimarySource` is false. */
  warning: string;
  /** ISO date of the last verification pass, or null if never. */
  lastVerified: string | null;
}

/**
 * Inclusionary zoning. It does not change the envelope, but it changes what
 * the envelope is worth building, so the threshold lives in data rather than
 * being buried in the calculator.
 */
export interface InclusionaryZoning {
  /** Unit count at or above which the requirement bites. */
  unitThreshold: number;
  citation: string;
  summary: string;
}

/** Typical standards for one family of districts, used only as a fallback. */
export interface FamilyDefaults {
  maxHeightFt: number;
  maxStories: number | null;
  maxLotCoverageRatio: number;
  minYardsFt: { front: number; side: number; rear: number };
  minLotAreaPerDwellingSf: number | null;
  multifamilyAllowed: boolean;
  /** Why these numbers, in a sentence a reader can argue with. */
  rationale: string;
}

export type DistrictFamily = DistrictCategory | "unknown";

/**
 * What the calculator uses when a parcel's own standard is unavailable, so
 * that an answer is always produced — labelled as an estimate, never as law.
 */
export interface EstimateDefaults {
  citation: string;
  note: string;
  families: Record<DistrictFamily, FamilyDefaults>;
}

/** The whole rule dataset. */
export interface RuleSet {
  jurisdiction: string;
  /** Dataset version, bumped whenever any value changes. */
  version: string;
  /** Edition of the land use code the values were transcribed from. */
  codeEdition: string;
  /** ISO date the code edition took effect. */
  codeEffectiveDate: string;
  /** Dataset-wide caveat rendered in the UI. */
  disclaimer: string;
  /** Citation for the land use code as a whole. */
  codeCitation: string;
  inclusionaryZoning: InclusionaryZoning;
  provenance: Provenance;
  citations: Citation[];
  estimateDefaults: EstimateDefaults;
  districts: DistrictRules[];
  overlays: OverlayRules[];
  statutePathways: StatutePathway[];
}
