/**
 * GET /api/analyze?address=...
 *
 * The same pipeline the page uses, exposed as JSON so the numbers can be
 * checked, scripted against, or diffed after a rule-data change.
 */
import { httpStatusFor, runAnalysis } from "@/lib/engine/run";

export async function GET(request: Request): Promise<Response> {
  const address = new URL(request.url).searchParams.get("address") ?? "";
  const outcome = await runAnalysis(address);

  if (!outcome.ok) {
    return Response.json(
      {
        error: outcome.message,
        kind: outcome.kind,
        candidates: outcome.candidates,
        sources: outcome.sources,
        gaps: outcome.gaps,
      },
      { status: httpStatusFor(outcome.kind) },
    );
  }

  return Response.json(outcome.result, {
    headers: {
      // Parcel and zoning data changes on the order of weeks, not seconds.
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
