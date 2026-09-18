/**
 * A plain GET form. No client JavaScript, no state library: the address lives
 * in the URL, which makes every result shareable and the back button work.
 */
export function AddressForm({ defaultValue = "" }: { defaultValue?: string }) {
  return (
    <form action="/" method="get" className="flex w-full flex-col gap-3 sm:flex-row">
      <label htmlFor="address" className="sr-only">
        Portland, Maine address
      </label>
      <input
        id="address"
        name="address"
        type="text"
        required
        defaultValue={defaultValue}
        autoComplete="street-address"
        placeholder="Enter Portland, Maine address"
        className="w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink-soft)] px-4 py-3 text-base text-[color:var(--color-paper)] placeholder:text-[color:var(--color-muted)] focus:border-[color:var(--color-accent)] focus:outline-none"
      />
      <button
        type="submit"
        className="rounded-lg bg-[color:var(--color-accent)] px-6 py-3 font-semibold text-[color:var(--color-ink)] transition hover:brightness-110 focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-accent)]"
      >
        Analyze
      </button>
    </form>
  );
}
