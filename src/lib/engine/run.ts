/**
 * One entry point for "address in, answer out", shared by the page and the
 * JSON API so they can never drift apart.
 */
import { lookupSite, SiteLookupError } from "../gis/site";
import { analyze } from "./envelope";
import type { AnalysisResult } from "./types";

export interface AnalysisFailure {
  ok: false;
  kind: "not-found" | "ambiguous" | "upstream" | "bad-request";
  message: string;
  /** Candidate addresses when the query matched more than one parcel. */
  candidates?: string[];
}

export type AnalysisOutcome = { ok: true; result: AnalysisResult } | AnalysisFailure;

export async function runAnalysis(address: string): Promise<AnalysisOutcome> {
  const query = address.trim();
  if (query.length === 0) {
    return { ok: false, kind: "bad-request", message: "Enter a Portland, Maine address." };
  }

  try {
    const site = await lookupSite(query);
    return { ok: true, result: analyze(site, query) };
  } catch (error) {
    if (error instanceof SiteLookupError) {
      return {
        ok: false,
        kind: error.kind,
        message: error.message,
        candidates: error.candidates.length > 0 ? error.candidates : undefined,
      };
    }
    return {
      ok: false,
      kind: "upstream",
      message:
        error instanceof Error
          ? `The analysis could not be completed: ${error.message}`
          : "The analysis could not be completed.",
    };
  }
}

export const httpStatusFor = (kind: AnalysisFailure["kind"]): number =>
  kind === "bad-request" ? 400 : kind === "not-found" ? 404 : kind === "ambiguous" ? 409 : 502;
