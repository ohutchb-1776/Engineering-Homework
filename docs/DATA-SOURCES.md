# Data sources

Everything the app reads, why it reads it, and what happens when it is
unavailable. No source needs an API key.

## Geography — City of Portland ArcGIS REST services

Root: `https://gis.portlandmaine.gov/maps/rest/services`

| Layer | Used for | Required |
|---|---|---|
| `Development_Review_Parcels/MapServer/0` | Parcel boundary, address, parcel id, lot area | yes |
| `Zoning/MapServer/5` | Base zoning district | yes |
| `Zoning/MapServer/6` | Overlay zones | no |
| `Zoning/MapServer/2` | Shoreland overlay | no |
| `Zoning/MapServer/3` | Stream protection overlay | no |
| `Zoning/MapServer/1` | Coastal stability / bluffs | no |
| `transportation/Streets/MapServer/0` | Street centrelines, to identify the front lot line | no |
| `Historic/MapServer/0` | Locally designated historic districts | no |

Layer numbers move when the city republishes a service. **The numbers above
have not been confirmed against the live server** — see the note in the README
— so run `npm run gis:probe` before trusting them, and override whatever it
reports as `FAIL` using `.env.example`.

The app never assumes a field name. It reads each layer's own field list and
matches against a candidate list in `src/lib/gis/fields.ts`, so `ADDRESS`,
`FULL_ADDRESS`, `SITE_ADDR` and `PROP_LOC` all work. A layer with none of the
names it knows is reported as a gap rather than silently skipped.

## Flood — FEMA National Flood Hazard Layer

`https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28`

Used to report whether the parcel is in a Special Flood Hazard Area. Flood zone
is reported as a constraint; it does not change the calculated height, though
in practice freeboard usually comes out of the habitable stories.

## Geocoding — US Census Bureau

`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress`

Only used when the parcel layer's own address field does not match what the
user typed. The parcel layer still decides which parcel the point falls in, so
the geocoder never determines the answer, only where to look.

## Zoning rules — City of Portland Code of Ordinances, Chapter 14

<https://www.portlandmaine.gov/city-code>

Transcribed into `data/rules/portland-me.json`. **Not yet verified against the
published text** — see [RULES.md](./RULES.md).

## State law — Maine Revised Statutes, Title 30-A

Read from `legislature.maine.gov` and marked `verified`:

- [§4364 — Affordable housing density](https://legislature.maine.gov/statutes/30-a/title30-Asec4364.html):
  an affordable housing development must be allowed to exceed any municipal
  height restriction by no less than one storey or 14 feet, must be allowed at
  least 2.5× the base dwelling-unit density where multifamily dwellings are
  allowed, and may not be required to provide more than 2 off-street parking
  spaces per 3 units.
- [§4364-A — Residential areas; up to 4 dwelling units](https://legislature.maine.gov/statutes/30-A/title30-Asec4364-A-2.html):
  at least 3 units per lot where residential use is allowed, and 4 in a
  designated growth area or where served by public water and sewer.
- [§4364-B — Accessory dwelling units](https://legislature.maine.gov/statutes/30-a/title30-Asec4364-B.html)
- [§4364-E — Residential units in areas zoned for commercial use](https://legislature.maine.gov/legis/statutes/30-A/title30-Asec4364-E.html)

## Basemap — OpenStreetMap

Raster tiles from `tile.openstreetmap.org`, rendered with MapLibre GL. No key,
no account. If you deploy this with real traffic, move to a tile host with a
usage policy that permits it.

## Failure behaviour

A required layer that fails ends the analysis with an error naming the layer.
An optional layer that fails is recorded as a **gap** and shown to the user:
"we could not check for a shoreland overlay" is a different answer from "there
is no shoreland overlay", and the app never conflates them.
