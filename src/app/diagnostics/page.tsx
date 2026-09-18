/**
 * What this host can actually reach.
 *
 * The app works or fails entirely on whether it can get to the City of
 * Portland's GIS, and that differs between a laptop and a deployed server.
 * This page runs the same resolution the analysis runs and shows the result,
 * so "it doesn't work" can be diagnosed from a browser without a terminal.
 */
import Link from "next/link";
import { LAYER_SPEC_BY_KEY } from "@/lib/gis/config";
import { resolveAllLayers } from "@/lib/gis/discovery";
import { getLayerInfo } from "@/lib/gis/arcgis";
import { resolveField, type FieldConcept } from "@/lib/gis/fields";
import { ruleSet } from "@/lib/rules/load";

export const dynamic = "force-dynamic";

export const metadata = { title: "Diagnostics — How tall can you build?" };

const CONCEPTS: Partial<Record<string, FieldConcept[]>> = {
  parcels: ["address", "parcelId"],
  zoning: ["zoningDistrict", "zoningName", "maxHeightFt"],
  overlays: ["overlayName"],
  shoreland: ["overlayName"],
  stream: ["overlayName"],
  coastalStability: ["overlayName"],
  historic: ["overlayName"],
  flood: ["floodZone"],
  streets: ["streetName"],
};

interface LayerReport {
  key: string;
  label: string;
  required: boolean;
  url: string | null;
  via: string;
  serverName?: string;
  attempts: { url: string; outcome: string }[];
  fields: { concept: string; field: string | null; available?: string[] }[];
  readError?: string;
  envVar: string;
}

async function buildReport(): Promise<LayerReport[]> {
  const resolved = await resolveAllLayers(true);

  return Promise.all(
    resolved.map(async (layer): Promise<LayerReport> => {
      const envVar = LAYER_SPEC_BY_KEY[layer.key]?.envVar ?? "";
      const report: LayerReport = { ...layer, fields: [], envVar };
      if (!layer.url) return report;

      try {
        const info = await getLayerInfo(layer.url);
        report.fields = (CONCEPTS[layer.key] ?? []).map((concept) => {
          const field = resolveField(info.fields, concept);
          return {
            concept,
            field,
            available: field ? undefined : info.fields.map((f) => f.name),
          };
        });
      } catch (error) {
        report.readError = error instanceof Error ? error.message : String(error);
      }
      return report;
    }),
  );
}

export default async function DiagnosticsPage() {
  const report = await buildReport();
  const brokenRequired = report.filter((r) => r.required && (!r.url || r.readError));
  const healthy = report.filter((r) => r.url && !r.readError).length;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-2">
        <Link
          href="/"
          className="text-sm text-[color:var(--color-accent)] underline underline-offset-2"
        >
          ← back
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">Diagnostics</h1>
        <p className="text-[color:var(--color-muted)]">
          What this server can reach right now. {healthy} of {report.length} layers resolved.
        </p>
      </header>

      <section
        className={`rounded-xl border p-5 ${
          brokenRequired.length > 0
            ? "border-[color:var(--color-warn)]/60 bg-[color:var(--color-warn)]/10"
            : "border-[color:var(--color-rule)]/50 bg-[color:var(--color-rule)]/10"
        }`}
      >
        {brokenRequired.length === 0 ? (
          <p className="font-semibold">
            Every required layer resolved. Address lookups should work.
          </p>
        ) : (
          <>
            <p className="font-semibold">
              {brokenRequired.length} required layer
              {brokenRequired.length === 1 ? "" : "s"} could not be reached, so address lookups will
              fail.
            </p>
            <p className="mt-2 text-sm text-[color:var(--color-muted)]">
              Find a working URL below or on the city&rsquo;s ArcGIS services directory, then set
              the environment variable named on that layer and redeploy. If nothing on
              gis.portlandmaine.gov responds at all, the city&rsquo;s server is down or is blocking
              this host — parcels can fall back to Maine GeoLibrary, but zoning has no substitute.
            </p>
          </>
        )}
      </section>

      <ul className="flex flex-col gap-4">
        {report.map((layer) => (
          <li
            key={layer.key}
            className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-ink-soft)] p-5"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded px-1.5 py-0.5 text-[11px] font-medium tracking-wide uppercase ${
                  layer.url && !layer.readError
                    ? "bg-[color:var(--color-rule)]/15 text-[color:var(--color-rule)]"
                    : "bg-[color:var(--color-warn)]/15 text-[color:var(--color-warn)]"
                }`}
              >
                {layer.url && !layer.readError ? "resolved" : "unresolved"}
              </span>
              <span className="font-semibold">{layer.label}</span>
              {layer.required ? (
                <span className="text-xs text-[color:var(--color-muted)]">required</span>
              ) : null}
            </div>

            {layer.url ? (
              <>
                <p className="numeric mt-2 font-mono text-xs break-all text-[color:var(--color-accent)]">
                  {layer.url}
                </p>
                <p className="mt-1 text-xs text-[color:var(--color-muted)]">
                  found via {layer.via}
                  {layer.serverName ? ` — the server calls it “${layer.serverName}”` : ""}
                </p>
              </>
            ) : null}

            {layer.readError ? (
              <p className="mt-2 text-sm text-[color:var(--color-warn)]">
                Resolved, but could not be read: {layer.readError}
              </p>
            ) : null}

            {layer.fields.length > 0 ? (
              <dl className="mt-3 flex flex-col gap-1 text-sm">
                {layer.fields.map((field) => (
                  <div key={field.concept} className="flex flex-wrap gap-2">
                    <dt className="text-[color:var(--color-muted)]">{field.concept}:</dt>
                    <dd
                      className={
                        field.field
                          ? "font-mono text-[color:var(--color-paper)]"
                          : "text-[color:var(--color-warn)]"
                      }
                    >
                      {field.field ?? "no recognised field"}
                    </dd>
                    {field.available ? (
                      <dd className="basis-full font-mono text-xs text-[color:var(--color-muted)]">
                        available: {field.available.join(", ")}
                      </dd>
                    ) : null}
                  </div>
                ))}
              </dl>
            ) : null}

            {!layer.url ? (
              <>
                <p className="mt-3 text-sm">
                  Set{" "}
                  <code className="font-mono text-[color:var(--color-accent)]">{layer.envVar}</code>{" "}
                  to a working layer URL.
                </p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm text-[color:var(--color-muted)]">
                    {layer.attempts.length} endpoint
                    {layer.attempts.length === 1 ? "" : "s"} tried
                  </summary>
                  <ul className="mt-2 flex flex-col gap-2">
                    {layer.attempts.map((attempt, index) => (
                      <li key={`${attempt.url}-${index}`} className="text-xs">
                        <p className="font-mono break-all text-[color:var(--color-muted)]">
                          {attempt.url}
                        </p>
                        <p className="text-[color:var(--color-warn)]">{attempt.outcome}</p>
                      </li>
                    ))}
                  </ul>
                </details>
              </>
            ) : null}
          </li>
        ))}
      </ul>

      <section className="rounded-xl border border-[color:var(--color-line)] p-5 text-sm">
        <h2 className="font-semibold tracking-wide uppercase">Rule data</h2>
        <p className="mt-2 text-[color:var(--color-muted)]">
          v{ruleSet.version} — {ruleSet.codeEdition}. Verified against the primary source:{" "}
          <strong
            className={
              ruleSet.provenance.verifiedAgainstPrimarySource
                ? "text-[color:var(--color-rule)]"
                : "text-[color:var(--color-warn)]"
            }
          >
            {ruleSet.provenance.verifiedAgainstPrimarySource ? "yes" : "no"}
          </strong>
          . {ruleSet.districts.length} districts, {ruleSet.overlays.length} overlays.
        </p>
      </section>
    </main>
  );
}
