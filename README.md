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

**The GIS endpoints are likewise unconfirmed against the live server**, which
is why the app does not trust them: it discovers its layers at run time, and
`/diagnostics` shows you what it actually found.

Every value in the dataset carries `"confidence": "needs-verification"`, the
app shows an unverified-data banner on every result, and
[`docs/RULES.md`](docs/RULES.md) has the procedure for the verification pass.
Two things *are* verified, read from `legislature.maine.gov`: the Maine
statutes at 30-A M.R.S. §§ 4364, 4364-A, 4364-B and 4364-E.

The honest summary: **the engine is finished and tested; the data needs one
verification pass before anyone relies on a number.**

---

## What it does

0. Finds the city's GIS layers, by searching candidate services and matching
   layers by **name** rather than by index, then falling back to the ArcGIS
   Online web map the city publishes.
1. Resolves the address against the City of Portland parcel layer: a
   combined address field first (loosening the street suffix if the strict
   match misses), then separate number + street fields, then the city's own
   address points, then the US Census geocoder with a point-in-parcel query,
   then the nearest parcel within 500 ft — because an address on a square or
   other public way geocodes into the right-of-way and lands inside no parcel
   at all. Every loosening is reported, never silent.
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

## Deploying it

Import the repo at [vercel.com/new](https://vercel.com/new) and deploy — there
is nothing to configure. It needs a Node server rather than a static host,
because it proxies the city's GIS through its own route handlers and renders
the result server-side.

After the first deploy, open `/diagnostics` on the deployed URL to confirm that
host can reach the city's GIS.

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
npm run gis:probe    # where every layer resolves to right now, and why
npm run gis:probe -- "389 Congress St"   # ...and a full end-to-end analysis
npm run rules:lint   # dataset integrity, and what still needs verifying
npm run build && npm start
```

## When addresses stop resolving

Open **`/diagnostics`**. It runs the same endpoint resolution the analysis
runs and reports, per layer, where it resolved to, how it was found, and which
field names it matched — or, if it failed, every endpoint it tried and the
reason each one did not work. Use it rather than the terminal when the app
works locally but not on a deployed host; the two have different network
access, and that difference is usually the whole problem.

`npm run gis:probe` prints the same report on the command line.

Only if a layer comes back **unresolved** do you need to configure anything:
set the environment variable named on that layer to a working URL
(see `.env.example`) and redeploy.

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
- No database. No auth. No LLM. No API keys. Eight runtime dependencies.

The page is a server component; the address lives in the URL, so results are
shareable and the back button works. The form is a plain `GET` form and needs
no JavaScript. The only client component is the map.

**The parcel layer is taken from the city's Parcel Viewer web map first.**
A service named `Development_Review_Parcels` resolves happily by name and is
only the parcels under development review — a subset that produced "no parcel
within 300 ft of Monument Square", which is impossible against the real
fabric. So for parcels the city's published viewer wins over any guessed
service, every name match is checked for the right geometry (a "Parcel
Labels" point layer is not a parcel layer), and review/label/line layers are
excluded outright.

**Endpoints are discovered, not hardcoded.** A municipal GIS layer's index
changes whenever the service is republished, so `.../Zoning/MapServer/5`
becomes wrong without warning — and the failure is worse than a crash, because
layer 5 still returns *something*. So the app asks each service what layers it
has and matches by name, with exclusions (`"Shoreland Overlay Zone"` contains
`"overlay zone"`, and must not be mistaken for the generic overlay layer). If
the service itself has moved, it reads the city's published web map, which the
city maintains and therefore stays correct on its own. Parcels have a final
fallback to Maine GeoLibrary's statewide layer. Every step is recorded and
shown on `/diagnostics`.

```
data/rules/portland-me.json   every zoning number, with citations — no rule lives in src/
data/test-addresses.json      ten real Portland addresses across district types
src/lib/geometry/             local ft projection; per-edge setback clipping
src/lib/gis/                  endpoint discovery, ArcGIS client, field + address matching
src/lib/rules/                dataset schema and loader
src/lib/engine/               the calculation and its explanation trace
src/app/                      the page, the JSON API, and /diagnostics
scripts/gis-probe.ts          where every layer resolves, on the command line
scripts/rules-lint.ts         dataset integrity and verification status
tests/                        109 tests, no network
```

### Why there is no LLM

The brief allows one as an explanation layer. It is not needed: the engine
already emits a structured trace with a sentence, a formula and a citation for
each step, which is what an explanation layer would have been asked to produce
— except this version cannot hallucinate, needs no key, and costs nothing. If
you add one later, it should read the trace and never the code.

### Tests

109 tests, no network access required.

```
tests/geometry.test.ts   setback clipping, frontage detection, projection accuracy
tests/engine.test.ts     the envelope calculation end to end on synthetic parcels
tests/rules.test.ts      dataset integrity: citations, confidence, sane ranges
tests/gis.test.ts        address normalisation, field resolution, overlay mapping
tests/discovery.test.ts  endpoint discovery, name matching, and the fallback chain
tests/address-matching.test.ts  suffix mismatches, and addresses on public squares
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
