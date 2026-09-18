# Data sources

Everything the app reads, why it reads it, and what happens when it is
unavailable. No source needs an API key.

## Geography — City of Portland ArcGIS REST services

Root: `https://gis.portlandmaine.gov/maps/rest/services`

| Layer | Used for | Required |
|---|---|---|
| Parcels | Parcel boundary, address, parcel id, lot area | yes |
| Base zoning districts | The zoning district | yes |
| Overlay zones | Mapped overlays | no |
| Shoreland overlay | Shoreland setbacks and coverage cap | no |
| Stream protection overlay | Stream setbacks | no |
| Coastal stability / bluffs | Geotechnical review flag | no |
| Street centrelines | Identifying the front lot line | no |
| Historic districts | Historic review flag | no |

**No URL above is hardcoded**, because layer indices move whenever a service is
republished — and that failure is worse than a crash, since the old index
usually still returns *something*. Instead `src/lib/gis/discovery.ts` resolves
each layer at run time:

1. the layer's environment variable, if set, used verbatim;
2. each candidate service in `src/lib/gis/config.ts`, whose layer list is
   searched **by name**, with exclusions — `"Shoreland Overlay Zone"` contains
   `"overlay zone"`, so the generic overlay layer must be stopped from
   resolving to it;
3. the operational layers of the city's published ArcGIS Online web map, which
   the city maintains, so a renamed or relocated service fixes itself;
4. for parcels only, Maine GeoLibrary's statewide layer.

Successful resolutions are cached for an hour; failures are always retried, so
a brief outage does not pin the app to "broken". Everything tried, and why each
attempt failed, is shown at **`/diagnostics`** and by `npm run gis:probe`.

Field names are handled the same way: the app reads each layer's own field list
and matches against candidates in `src/lib/gis/fields.ts`, so `ADDRESS`,
`FULL_ADDRESS`, `SITE_ADDR` and `PROP_LOC` all work. A layer with none of the
names it knows is reported as a gap rather than silently skipped.

## Parcel fallback — Maine GeoLibrary

[Maine Parcels, Organized Towns](https://hub.arcgis.com/datasets/maine::maine-parcels-organized-towns-1),
a standardized statewide parcel layer hosted on ArcGIS Online rather than on
the city's own server. Used only when every Portland parcel candidate fails.

It carries no zoning, and **zoning has no substitute**: only Portland publishes
Portland's districts and overlays. If the city's server is unreachable you can
still get lot geometry, but the district will read as unknown and the app will
decline to produce an envelope.

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
