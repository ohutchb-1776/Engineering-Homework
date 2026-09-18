/**
 * The shape of an answer.
 *
 * Every number the UI shows comes back wrapped in a `Figure`, and every
 * `Figure` knows which of four things it is: something the GIS measured, a
 * rule from the code, an assumption this app made up, or a statute. That
 * distinction is the whole point of the tool — a reader must never have to
 * guess whether "45 ft" is law or arithmetic.
 */
import type { Confidence } from "../rules/schema";
import type { SourceRecord } from "../gis/site";

export type Basis =
  /** Measured from city GIS geometry. */
  | "gis"
  /** A number in the municipal code. */
  | "rule"
  /** A modelling choice this app made; not law. */
  | "assumption"
  /** Derived arithmetic from the above. */
  | "calculation"
  /** A state statute that overrides or supplements local zoning. */
  | "statute";

export interface Figure {
  /** null means "we could not determine this", never "zero". */
  value: number | null;
  unit: string;
  /**
   * For results that are not a quantity — a district code, say. When set it is
   * displayed instead of `value`, so a non-numeric step never renders as
   * "not determined".
   */
  text?: string;
  basis: Basis;
  /** Citation id from the rule dataset, when `basis` is "rule" or "statute". */
  citation?: string;
  confidence?: Confidence;
  /** Why this value is what it is, in one sentence. */
  why: string;
}

export interface TraceStep {
  id: string;
  label: string;
  basis: Basis;
  /** Plain-language sentence, written for someone reading it in a hurry. */
  detail: string;
  /** The arithmetic, written out, when there is any. */
  formula?: string;
  citation?: string;
  result: Figure;
}

export type ConstraintSeverity = "blocking" | "limiting" | "advisory";

export interface Constraint {
  id: string;
  title: string;
  severity: ConstraintSeverity;
  detail: string;
  citation?: string;
  /** True when a board or agency, not a table, decides the outcome. */
  discretionary: boolean;
}

export interface Assumption {
  id: string;
  label: string;
  value: string;
  why: string;
}

export interface Envelope {
  maxHeightFt: Figure;
  stories: Figure;
  maxFootprintSf: Figure;
  grossFloorAreaSf: Figure;
  estimatedUnits: Figure;
}

export interface Scenario {
  id: "base" | "affordable";
  label: string;
  /** One line explaining what this scenario assumes. */
  premise: string;
  envelope: Envelope;
  /** Present only on non-base scenarios. */
  statuteCitation?: string;
}

export interface AnalysisResult {
  address: {
    query: string;
    matched: string;
    parcelId: string | null;
    matchMethod: string;
  };
  parcel: {
    lotAreaSf: Figure;
    /** GeoJSON, WGS84, for the map. */
    geometry: unknown;
    /** The hypothetical footprint, GeoJSON WGS84, or null if none fits. */
    buildableGeometry: unknown;
  };
  zoning: {
    districtCode: string | null;
    districtName: string | null;
    /** True when the district was found in the rule dataset. */
    districtKnown: boolean;
  };
  overlays: { id: string | null; name: string; description: string | null }[];
  scenarios: Scenario[];
  constraints: Constraint[];
  assumptions: Assumption[];
  trace: TraceStep[];
  sources: SourceRecord[];
  /** Things the app could not determine. Shown, never hidden. */
  gaps: string[];
  ruleData: {
    version: string;
    codeEdition: string;
    codeEffectiveDate: string;
    verified: boolean;
    warning: string;
    disclaimer: string;
  };
  /** Citations actually referenced by this result. */
  citations: {
    id: string;
    document: string;
    section: string;
    title?: string;
    url: string;
    edition: string;
  }[];
}
