import { AddressForm } from "@/components/AddressForm";
import { Result } from "@/components/Result";
import { runAnalysis } from "@/lib/engine/run";
import testAddresses from "../../data/test-addresses.json";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ address?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.address) ? params.address[0] : params.address;
  const address = raw?.trim() ?? "";
  const outcome = address ? await runAnalysis(address) : null;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 sm:py-16">
      <header className="flex flex-col gap-5">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">How tall can you build?</h1>
        <p className="max-w-prose text-[color:var(--color-muted)]">
          Enter a Portland, Maine address. This works out the tallest apartment building that the
          parcel&rsquo;s zoning and mapped site constraints would plausibly allow, and shows every
          step and source behind the number.
        </p>
        <AddressForm defaultValue={address} />
      </header>

      {outcome === null ? <Intro /> : null}

      {outcome && !outcome.ok ? (
        <div className="rounded-xl border border-[color:var(--color-warn)]/60 bg-[color:var(--color-warn)]/10 p-5">
          <p className="font-semibold text-[color:var(--color-paper)]">{outcome.message}</p>
          {outcome.candidates ? (
            <ul className="mt-3 flex flex-col gap-1 text-sm">
              {outcome.candidates.map((candidate) => (
                <li key={candidate}>
                  <a
                    href={`/?address=${encodeURIComponent(candidate)}`}
                    className="text-[color:var(--color-accent)] underline underline-offset-2"
                  >
                    {candidate}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          {outcome.kind === "upstream" ? (
            <p className="mt-3 text-sm text-[color:var(--color-muted)]">
              This usually means the City of Portland&rsquo;s GIS service is down or has moved. Run{" "}
              <code className="font-mono">npm run gis:probe</code> to see which layers are reachable.
            </p>
          ) : null}
        </div>
      ) : null}

      {outcome?.ok ? <Result result={outcome.result} /> : null}

      <footer className="border-t border-[color:var(--color-line)] pt-6 text-sm text-[color:var(--color-muted)]">
        <p>
          An independent early-stage feasibility tool. Not affiliated with the City of Portland, and
          not a zoning determination. Only the city&rsquo;s Planning &amp; Urban Development
          Department can tell you what may actually be built on a parcel.
        </p>
      </footer>
    </main>
  );
}

function Intro() {
  const samples = testAddresses.addresses.slice(0, 4);
  return (
    <section className="flex flex-col gap-6">
      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-ink-soft)] p-5">
        <h2 className="text-sm font-semibold tracking-wide uppercase">What you get</h2>
        <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-sm text-[color:var(--color-muted)]">
          <li>A maximum height, and roughly how many storeys that is</li>
          <li>The buildable footprint after setbacks and lot coverage</li>
          <li>Gross floor area and a rough apartment count</li>
          <li>Every overlay and constraint the city&rsquo;s GIS reports on the parcel</li>
          <li>The derivation, step by step, with the rule behind each number</li>
        </ul>
      </div>

      <div>
        <h2 className="text-sm font-semibold tracking-wide uppercase">Try an address</h2>
        <ul className="mt-3 flex flex-wrap gap-2">
          {samples.map((sample) => (
            <li key={sample.address}>
              <a
                href={`/?address=${encodeURIComponent(sample.address)}`}
                className="inline-block rounded-lg border border-[color:var(--color-line)] px-3 py-1.5 text-sm text-[color:var(--color-accent)] hover:border-[color:var(--color-accent)]"
              >
                {sample.address}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
