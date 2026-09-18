# How tall can you build?

Enter a Portland, Maine address. Get an estimate of the tallest apartment
building that the parcel's zoning and mapped site constraints would plausibly
allow — and the derivation behind every number.

```
389 Congress St

Hypothetical maximum height
65 ft
≈ 6 storeys
```

It has exactly one job. It is not a permit application, not a zoning
determination, and not a general real-estate platform.

---

## Read this first

**The zoning numbers in this repository have not been verified against the
City of Portland's published code.**

They were transcribed by hand; the machine that produced them had no network
route to `portlandmaine.gov`, `library.municode.com`, or the city's GIS server.
Portland recodified its entire land use ordinance under **ReCode Portland**,
effective **4 December 2024**, so the district standards here may be wrong in
either direction.

**The GIS layer numbers in `src/lib/gis/config.ts` are likewise unconfirmed
against the live server.** Run `npm run gis:probe` before trusting them.

Every value in the dataset carries `"confidence": "needs-verification"`, the
app shows an unverified-data banner on every result, and
[`docs/RULES.md`](docs/RULES.md) has the procedure for the verification pass.
Two things *are* verified, read from `legislature.maine.gov`: the Maine
statutes at 30-A M.R.S. §§ 4364, 4364-A, 4364-B and 4364-E.

The honest summary: **the engine is finished and tested; the data needs one
verification pass before anyone relies on a number.**

---

## What it does

1. Resolves the address against the City of Portland parcel layer — by the
   layer's own address field first, falling back to the US Census geocoder and
   a point-in-parcel query.
2. Measures the lot from the mapped boundary.
3. Reads the base zoning district from the city's zoning layer.
4. Collects overlays: shoreland, stream protection, coastal stability, historic
   districts, the city's overlay layer, and the FEMA flood layer.
5. Applies the district's dimensional standards from a versioned, cited rule
   dataset — never from a model's memory.
6. Computes the envelope: height, storeys, footprint after setbacks and
   coverage, gross floor area, and a rough apartment count.
7. Shows the derivation step by step, with the rule behind each number.

Every figure is labelled with what kind of number it is:

| Badge | Meaning |
|---|---|
| **measured** | City of Portland GIS geometry |
| **zoning rule** | A figure in the municipal code, with a citation |
| **state law** | A Maine statute that overrides the local rule |
| **our assumption** | A modelling choice this app made — not law |
| **calculated** | Arithmetic on the above |

When something cannot be determined, the app says "not determined" and lists it
under *What this app could not determine*. It never substitutes a plausible
default. A district that is not in the rule dataset produces no envelope at
all.

### Portland-specific things it knows

- District dimensional standards: height, lot area, land area per dwelling
  unit, FAR, lot coverage, front/side/rear yards, street frontage.
- Shoreland and stream-protection setbacks, and their coverage caps.
- Historic districts and coastal-stability areas, reported as constraints
  decided by a board rather than by a table.
- That Portland removed residential off-street parking minimums citywide in
  December 2023.
- That inclusionary zoning bites at 10 units.
- That the downtown height overlay, not the base district, governs on the
  peninsula — and it prefers a height published on the city's own zoning layer
  over the transcribed table.
- The Maine statutes that override local zoning: the 3-to-4 unit minimum
  (§4364-A), and the affordable-housing height and density floor (§4364), which
  is offered as a clearly separated alternative scenario rather than folded
  into the base answer.

---

## Running it

Requires **Node.js 20.9+**.

```bash
npm install
npm run dev          # http://localhost:3000
```

No configuration, no API keys, no database, no auth, no LLM. Every data source
is a public keyless endpoint.

```bash
npm run check        # rules lint + typecheck + tests + eslint
npm test             # tests only
npm run gis:probe    # what the city's GIS is actually serving right now
npm run gis:probe -- "389 Congress St"   # ...and a full end-to-end analysis
npm run rules:lint   # dataset integrity, and what still needs verifying
npm run build && npm start
```

`npm run gis:probe` is the first thing to run when the app reports layers as
unavailable. It prints, per layer, whether it resolves, what it is called, and
which of the field names the app looks for it actually has — which is exactly
what you need to fix `src/lib/gis/config.ts` or `src/lib/gis/fields.ts`. Copy
`.env.example` to `.env.local` to override any endpoint it reports as `FAIL`.

### A JSON API

```bash
curl 'http://localhost:3000/api/analyze?address=389%20Congress%20St'
```

Returns the full result including the trace, the citations and the gaps. The
page and the API run the same pipeline, so they cannot drift.

---

## How it is built

- **Next.js 16** (App Router) + **TypeScript** + **Tailwind 4**
- **MapLibre GL** with OpenStreetMap raster tiles — no key
- **polygon-clipping** for setback geometry, **@turf/area** for geodesic areas,
  **@esri/arcgis-to-geojson-utils** for Esri→GeoJSON
- No database. No auth. No LLM. Eight runtime dependencies.

The page is a server component; the address lives in the URL, so results are
shareable and the back button works. The form is a plain `GET` form and needs
no JavaScript. The only client component is the map.

```
data/rules/portland-me.json   every zoning number, with citations — no rule lives in src/
data/test-addresses.json      ten real Portland addresses across district types
src/lib/geometry/             local ft projection; per-edge setback clipping
src/lib/gis/                  ArcGIS client, field resolution, address matching, site lookup
src/lib/rules/                dataset schema and loader
src/lib/engine/               the calculation and its explanation trace
src/app/                      one page, one API route
scripts/gis-probe.ts          what the city's GIS is serving
scripts/rules-lint.ts         dataset integrity and verification status
tests/                        78 tests, no network
```

### Why there is no LLM

The brief allows one as an explanation layer. It is not needed: the engine
already emits a structured trace with a sentence, a formula and a citation for
each step, which is what an explanation layer would have been asked to produce
— except this version cannot hallucinate, needs no key, and costs nothing. If
you add one later, it should read the trace and never the code.

### Tests

78 tests, no network access required.

```
tests/geometry.test.ts   setback clipping, frontage detection, projection accuracy
tests/engine.test.ts     the envelope calculation end to end on synthetic parcels
tests/rules.test.ts      dataset integrity: citations, confidence, sane ranges
tests/gis.test.ts        address normalisation, field resolution, overlay mapping
tests/pipeline.test.ts   address in, answer out, against a fake ArcGIS server
```

`tests/pipeline.test.ts` stands up a local server that speaks the parts of the
ArcGIS REST API the app uses, so the field resolution, the SQL the client
builds, the spatial filter and the Esri-to-GeoJSON conversion are exercised
rather than mocked. Its fake rejects any `WHERE` clause it does not recognise,
so a change to the generated SQL cannot quietly pass.

The engine tests assert on *behaviour that must hold whatever the numbers are*
— that an unknown district yields nulls rather than guesses, that the most
restrictive rule wins, that the no-frontage fallback is the more conservative
of the two, that an unmapped overlay becomes a visible gap.

---

## Documentation

- [`docs/RULES.md`](docs/RULES.md) — verifying and updating the zoning data,
  and what deliberately is not modelled
- [`docs/DATA-SOURCES.md`](docs/DATA-SOURCES.md) — every source, and what
  happens when one is down
- [`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md) — every modelling choice, and
  how wrong each one can be

---

## Limits

The calculation ignores project economics entirely: "best" means the largest
plausible *conforming* envelope, not the one worth building. It does not model
Portland's own height and FAR bonuses, conditional uses, contract zones,
fire-code limits on construction type, site-plan review, easements, or existing
structures. [`docs/RULES.md`](docs/RULES.md#what-deliberately-is-not-modelled)
has the full list.

**This is not a zoning determination.** Confirm anything that matters with the
City of Portland Planning & Urban Development Department.

## Licence

MIT.
