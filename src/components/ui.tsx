import type { Basis, Figure } from "@/lib/engine/types";

/**
 * The badge that answers "should I trust this number?" — it is the most
 * important piece of UI in the app, so it appears next to every figure.
 */
const BASIS_LABEL: Record<Basis, string> = {
  gis: "measured",
  rule: "zoning rule",
  assumption: "our assumption",
  calculation: "calculated",
  statute: "state law",
};

const BASIS_CLASS: Record<Basis, string> = {
  gis: "bg-[color:var(--color-accent)]/15 text-[color:var(--color-accent)]",
  rule: "bg-[color:var(--color-rule)]/15 text-[color:var(--color-rule)]",
  assumption: "bg-[color:var(--color-assume)]/15 text-[color:var(--color-assume)]",
  calculation: "bg-white/10 text-[color:var(--color-muted)]",
  statute: "bg-[color:var(--color-rule)]/15 text-[color:var(--color-rule)]",
};

export function BasisBadge({ basis }: { basis: Basis }) {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium tracking-wide uppercase ${BASIS_CLASS[basis]}`}
    >
      {BASIS_LABEL[basis]}
    </span>
  );
}

export function formatFigure(figure: Figure): string {
  if (figure.text) return figure.text;
  if (figure.value === null) return "not determined";
  const rounded = Math.round(figure.value);
  switch (figure.unit) {
    case "ft":
      return `${rounded.toLocaleString()} ft`;
    case "sf":
      return `${rounded.toLocaleString()} sf`;
    case "storeys":
      return `${rounded} ${rounded === 1 ? "storey" : "storeys"}`;
    case "units":
      return `${rounded} ${rounded === 1 ? "unit" : "units"}`;
    default:
      return `${rounded.toLocaleString()} ${figure.unit}`;
  }
}

export function Panel({
  title,
  children,
  subtitle,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-ink-soft)] p-5">
      <h2 className="text-sm font-semibold tracking-wide text-[color:var(--color-paper)] uppercase">
        {title}
      </h2>
      {subtitle ? <p className="mt-1 text-sm text-[color:var(--color-muted)]">{subtitle}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}
