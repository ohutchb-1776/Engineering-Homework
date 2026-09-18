# Verifying and updating the zoning rule data

Everything the calculator treats as law lives in one file:
**`data/rules/portland-me.json`**. No zoning number is hard-coded anywhere in
`src/`. That is deliberate — it means correcting the app is a data edit that a
planner can review, not a code change.

## The dataset has NOT been verified

`provenance.verifiedAgainstPrimarySource` is currently `false`.

The district dimensional standards in this file were transcribed by hand and
have **not** been read back against the published text of Chapter 14. The
machine that generated them had no network route to `portlandmaine.gov`,
`library.municode.com`, or the city's GIS. Every one of those values carries
`"confidence": "needs-verification"`.

Portland recodified its entire land use ordinance under **ReCode Portland**,
effective **4 December 2024**, so pre-2024 figures may be wrong in either
direction. Treat every district number as a starting point to check.

The statewide statutory pathways — 30-A M.R.S. §§ 4364, 4364-A, 4364-B,
4364-E — *were* read from `legislature.maine.gov` and are marked
`"verified"`.

The app says all of this on screen, on every result. Do not remove that banner
before doing the verification pass.

## How a value is shaped

```jsonc
"maxHeightFt": {
  "value": 45,                              // null means "we do not know"
  "source": "portland-ch14-residential",    // id in the citations array
  "confidence": "needs-verification",       // verified | needs-verification | not-stated
  "note": "optional caveats from the source"
}
```

Rules the calculator enforces, checked by `npm run rules:lint` and by
`tests/rules.test.ts`:

- every value cites a citation id that exists;
- `value: null` and `confidence: "not-stated"` always travel together — you may
  not record a null as if it were merely unverified, or a real number as if it
  were absent;
- every citation has a document, a section, an edition, and an `https` URL;
- no citation is left unreferenced;
- numbers stay inside physically sane ranges (height ≤ 1000 ft, coverage ≤ 1,
  and so on).

## The verification pass

Do this with the code open in one window and the JSON in another.

1. Open the current Chapter 14 (Land Use):
   <https://www.portlandmaine.gov/city-code>. Find the dimensional standards
   table for the district you are checking.
2. For each of the nine scalars and three yards on that district, compare the
   published figure to `value`.
3. When it matches: set `"confidence": "verified"` and set the citation's
   `section` to the real section or table number, and its `checked` to today's
   date.
4. When it differs: correct `value`, then set `"confidence": "verified"`.
5. When the code states no figure, or states it conditionally: set
   `"value": null`, `"confidence": "not-stated"`, and put the condition in
   `note`. **Do not invent a representative number.** A null produces
   "not determined" on screen, which is the honest answer.
6. Bump `version` and, once every district is done, set
   `provenance.verifiedAgainstPrimarySource` to `true` and
   `provenance.lastVerified` to the date.
7. Run `npm run check`.

Districts still needing a first pass are printed by `npm run rules:lint`.

This is separate from the GIS endpoints, which the app discovers by itself —
see `/diagnostics` and [DATA-SOURCES.md](./DATA-SOURCES.md). Rule data is the
part no amount of discovery can fix, because it lives in a PDF and not in a
service.

## Adding a district

The city's zoning map has districts this dataset does not hold — island
districts, form-based and contract zones among them. When the GIS returns a
code that is not in the file, the app refuses to produce an envelope and says
so. That is correct behaviour, and better than extrapolating from a district
that happens to look similar.

To add one, copy an existing entry, set every `value` you can source and leave
the rest `null`/`not-stated`, and add the citation.

## What deliberately is not modelled

These affect real projects and are **not** in the calculation. Several appear
as constraints on screen so a reader knows they are missing, but none of them
changes a number:

- height and FAR bonuses in Portland's own code (affordable housing, historic
  transfer of development rights, and similar);
- conditional uses, contract zones, and PAD/planned-development overlays;
- the downtown height overlay's mapped figures, unless the zoning layer
  publishes a height attribute the app can read;
- fire-code and building-code limits on construction type, which usually bind
  before zoning does above about five storeys of wood frame;
- shoreland zoning's subdistricts, each with different standards, and DEP
  jurisdiction;
- stormwater, traffic, and site-plan review thresholds;
- easements, rights of way, deed restrictions, and any private covenant;
- existing structures on the lot, and whether they are historic;
- soils, ledge, groundwater, and anything else that decides what is
  economically buildable rather than what is legally permitted.
