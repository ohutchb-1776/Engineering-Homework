import type { AnalysisResult, Constraint, Scenario } from "@/lib/engine/types";
import { BasisBadge, formatFigure, Panel } from "./ui";
import { ParcelMap } from "./ParcelMap";

const SEVERITY_CLASS: Record<Constraint["severity"], string> = {
  blocking: "border-[color:var(--color-warn)]/60 bg-[color:var(--color-warn)]/10",
  limiting: "border-[color:var(--color-assume)]/50 bg-[color:var(--color-assume)]/10",
  advisory: "border-[color:var(--color-line)] bg-white/5",
};

export function Result({ result }: { result: AnalysisResult }) {
  const base = result.scenarios.find((s) => s.id === "base") ?? result.scenarios[0]!;
  const alternate = result.scenarios.find((s) => s.id !== "base");
  const citationsById = new Map(result.citations.map((c) => [c.id, c]));

  return (
    <div className="flex flex-col gap-6">
      {!result.ruleData.verified ? (
        <p
          role="status"
          className="rounded-xl border border-[color:var(--color-warn)]/60 bg-[color:var(--color-warn)]/10 p-4 text-sm text-[color:var(--color-paper)]"
        >
          <strong className="font-semibold">Unverified rule data.</strong> {result.ruleData.warning}
        </p>
      ) : null}

      <Headline result={result} scenario={base} />

      {result.parcel.geometry ? (
        <ParcelMap
          parcel={result.parcel.geometry as GeoJSON.Geometry}
          envelope={(result.parcel.buildableGeometry as GeoJSON.Geometry | null) ?? null}
        />
      ) : null}

      <Panel
        title="The envelope"
        subtitle={base.premise}
      >
        <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg bg-[color:var(--color-line)] sm:grid-cols-2">
          <Cell label="Zoning district" value={result.zoning.districtCode ?? "unknown"} hint={result.zoning.districtName ?? undefined} />
          <Cell label="Lot area" value={formatFigure(result.parcel.lotAreaSf)} basis="gis" />
          <Cell label="Maximum footprint" value={formatFigure(base.envelope.maxFootprintSf)} basis={base.envelope.maxFootprintSf.basis} hint={base.envelope.maxFootprintSf.why} />
          <Cell label="Gross floor area" value={formatFigure(base.envelope.grossFloorAreaSf)} basis={base.envelope.grossFloorAreaSf.basis} hint={base.envelope.grossFloorAreaSf.why} />
          <Cell label="Estimated apartments" value={formatFigure(base.envelope.estimatedUnits)} basis={base.envelope.estimatedUnits.basis} hint={base.envelope.estimatedUnits.why} />
          <Cell label="Storeys" value={formatFigure(base.envelope.stories)} basis="assumption" hint={base.envelope.stories.why} />
        </dl>
        {result.parcel.buildableGeometry &&
        base.envelope.maxFootprintSf.value !== null &&
        base.envelope.maxFootprintSf.why.includes("coverage") ? (
          <p className="mt-3 text-sm text-[color:var(--color-muted)]">
            The green shape on the map is the area left after setbacks. The lot coverage cap is
            stricter, so the building itself must be smaller than the shape drawn.
          </p>
        ) : null}
      </Panel>

      {alternate ? <AlternateScenario scenario={alternate} /> : null}

      {result.overlays.length > 0 ? (
        <Panel title="Overlays on this parcel">
          <ul className="flex flex-col gap-3">
            {result.overlays.map((overlay) => (
              <li key={`${overlay.id ?? "unknown"}-${overlay.name}`} className="text-sm">
                <span className="font-semibold text-[color:var(--color-paper)]">{overlay.name}</span>
                {overlay.description ? (
                  <p className="mt-1 text-[color:var(--color-muted)]">{overlay.description}</p>
                ) : (
                  <p className="mt-1 text-[color:var(--color-warn)]">
                    This app has no rule for this overlay, so its effect is not included above.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {result.constraints.length > 0 ? (
        <Panel title="Constraints">
          <ul className="flex flex-col gap-3">
            {result.constraints.map((constraint) => (
              <li
                key={constraint.id}
                className={`rounded-lg border p-3 text-sm ${SEVERITY_CLASS[constraint.severity]}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-[color:var(--color-paper)]">{constraint.title}</span>
                  {constraint.discretionary ? (
                    <span className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] tracking-wide text-[color:var(--color-muted)] uppercase">
                      decided by a board, not a table
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-[color:var(--color-muted)]">{constraint.detail}</p>
                <CitationLink id={constraint.citation} citations={citationsById} />
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel
        title="How this was calculated"
        subtitle="Every step, in the order it was applied."
      >
        <ol className="flex flex-col gap-4">
          {result.trace.map((step) => (
            <li key={step.id} className="border-l-2 border-[color:var(--color-line)] pl-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-semibold text-[color:var(--color-paper)]">{step.label}</span>
                <span className="numeric text-[color:var(--color-accent)]">
                  {formatFigure(step.result)}
                </span>
                <BasisBadge basis={step.basis} />
              </div>
              <p className="mt-1 text-sm text-[color:var(--color-muted)]">{step.detail}</p>
              {step.formula ? (
                <p className="numeric mt-1 font-mono text-xs text-[color:var(--color-muted)]">
                  {step.formula}
                </p>
              ) : null}
              <CitationLink id={step.citation} citations={citationsById} />
            </li>
          ))}
        </ol>
      </Panel>

      <Panel
        title="Assumptions"
        subtitle="Choices this app made. None of these are zoning rules."
      >
        <dl className="flex flex-col gap-3">
          {result.assumptions.map((assumption) => (
            <div key={assumption.id} className="text-sm">
              <dt className="font-semibold text-[color:var(--color-paper)]">
                {assumption.label}: <span className="numeric font-normal text-[color:var(--color-assume)]">{assumption.value}</span>
              </dt>
              <dd className="mt-0.5 text-[color:var(--color-muted)]">{assumption.why}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      {result.gaps.length > 0 ? (
        <Panel
          title="What this app could not determine"
          subtitle="Listed rather than filled in with a guess."
        >
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-[color:var(--color-muted)]">
            {result.gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel title="Sources">
        <div className="flex flex-col gap-5 text-sm">
          <div>
            <h3 className="mb-2 font-semibold text-[color:var(--color-paper)]">Rules cited</h3>
            <ul className="flex flex-col gap-2">
              {result.citations.map((citation) => (
                <li key={citation.id}>
                  <a
                    href={citation.url}
                    className="text-[color:var(--color-accent)] underline underline-offset-2"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {citation.section}
                  </a>{" "}
                  <span className="text-[color:var(--color-muted)]">
                    — {citation.title ?? citation.document} ({citation.edition})
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 font-semibold text-[color:var(--color-paper)]">GIS layers queried</h3>
            <ul className="flex flex-col gap-1">
              {result.sources.map((source) => (
                <li key={`${source.key}-${source.url}`} className="text-[color:var(--color-muted)]">
                  <span
                    className={
                      source.status === "ok"
                        ? "text-[color:var(--color-rule)]"
                        : source.status === "empty"
                          ? "text-[color:var(--color-muted)]"
                          : "text-[color:var(--color-warn)]"
                    }
                  >
                    {source.status === "ok" ? "hit" : source.status === "empty" ? "no features" : "unavailable"}
                  </span>{" "}
                  {source.label}
                  {source.detail ? ` — ${source.detail}` : ""}
                </li>
              ))}
            </ul>
          </div>
          <p className="text-[color:var(--color-muted)]">
            Rule dataset v{result.ruleData.version}, transcribed from {result.ruleData.codeEdition}.
          </p>
        </div>
      </Panel>

      <p className="rounded-xl border border-[color:var(--color-line)] p-4 text-sm text-[color:var(--color-muted)]">
        {result.ruleData.disclaimer}
      </p>
    </div>
  );
}

function Headline({ result, scenario }: { result: AnalysisResult; scenario: Scenario }) {
  const height = scenario.envelope.maxHeightFt;
  return (
    <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-ink-soft)] p-6">
      <p className="text-sm text-[color:var(--color-muted)]">{result.address.matched}</p>
      <p className="mt-4 text-sm tracking-wide text-[color:var(--color-muted)] uppercase">
        Hypothetical maximum height
      </p>
      <p className="numeric mt-1 text-6xl font-bold text-[color:var(--color-paper)] sm:text-7xl">
        {formatFigure(height)}
      </p>
      <p className="numeric mt-1 text-2xl text-[color:var(--color-accent)]">
        ≈ {formatFigure(scenario.envelope.stories)}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <BasisBadge basis={height.basis} />
        <span className="text-sm text-[color:var(--color-muted)]">{height.why}</span>
      </div>
      <p className="mt-4 text-xs text-[color:var(--color-muted)]">{result.address.matchMethod}</p>
    </div>
  );
}

function AlternateScenario({ scenario }: { scenario: Scenario }) {
  return (
    <Panel title={scenario.label} subtitle={scenario.premise}>
      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg bg-[color:var(--color-line)] sm:grid-cols-3">
        <Cell label="Maximum height" value={formatFigure(scenario.envelope.maxHeightFt)} basis="statute" />
        <Cell label="Storeys" value={formatFigure(scenario.envelope.stories)} basis="assumption" />
        <Cell label="Estimated apartments" value={formatFigure(scenario.envelope.estimatedUnits)} basis="statute" />
      </dl>
      <p className="mt-3 text-sm text-[color:var(--color-muted)]">
        This scenario applies only if the project actually qualifies. It is not what the parcel
        allows today.
      </p>
    </Panel>
  );
}

function Cell({
  label,
  value,
  basis,
  hint,
}: {
  label: string;
  value: string;
  basis?: Parameters<typeof BasisBadge>[0]["basis"];
  hint?: string;
}) {
  return (
    <div className="bg-[color:var(--color-ink-soft)] p-4">
      <dt className="text-xs tracking-wide text-[color:var(--color-muted)] uppercase">{label}</dt>
      <dd className="numeric mt-1 text-xl font-semibold text-[color:var(--color-paper)]">{value}</dd>
      {basis ? (
        <div className="mt-2">
          <BasisBadge basis={basis} />
        </div>
      ) : null}
      {hint ? <p className="mt-2 text-xs text-[color:var(--color-muted)]">{hint}</p> : null}
    </div>
  );
}

function CitationLink({
  id,
  citations,
}: {
  id?: string;
  citations: Map<string, AnalysisResult["citations"][number]>;
}) {
  if (!id) return null;
  const citation = citations.get(id);
  if (!citation) return null;
  return (
    <p className="mt-1 text-xs">
      <a
        href={citation.url}
        target="_blank"
        rel="noreferrer"
        className="text-[color:var(--color-accent)] underline underline-offset-2"
      >
        {citation.section}
      </a>
      <span className="text-[color:var(--color-muted)]"> — {citation.title ?? citation.document}</span>
    </p>
  );
}
