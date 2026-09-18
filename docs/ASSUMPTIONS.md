# Assumptions

The app separates four kinds of number, and labels every figure on screen with
which one it is:

| Badge | Meaning |
|---|---|
| **measured** | Taken from City of Portland GIS geometry. |
| **zoning rule** | A figure in the municipal code, with a citation. |
| **state law** | A Maine statute that overrides or supplements the local rule. |
| **our assumption** | A modelling choice this app made. Not law. |
| **calculated** | Arithmetic on the above. |

This page lists the assumptions. They live in
`src/lib/engine/assumptions.ts` and can be changed in one place.

## Construction assumptions

| Assumption | Default | Why, and how wrong it can be |
|---|---|---|
| Floor-to-floor height | 10 ft | Typical for wood-frame multifamily. Ground-floor retail or concrete construction pushes this to 12–14 ft and costs a storey. |
| Roof and parapet | 3 ft | Taken off the height budget before counting storeys, because the limit is measured to the roof rather than to the top ceiling. |
| Gross-to-net efficiency | 82% | Corridors, stairs, lifts, walls and plant. A double-loaded corridor slab does better; a small or irregular floor plate does worse. |
| Average apartment | 750 sf net | A mix weighted toward one-bedrooms. Studio-heavy yields more units; family-sized yields fewer. |
| Surface parking | 325 sf per space | Space plus its share of aisle, used only to show how much lot a parking requirement would eat. |

## Geometric assumptions

**The building fills the setback envelope and is uniform on every floor.** Real
buildings step back, notch for light and air, and lose area to fire separation
and egress. The footprint here is an upper bound, not a design.

**Setbacks are applied as half-plane cuts.** Each lot line is pushed inward by
its required yard and the buildable area is what survives all the cuts. For a
convex lot this is exactly the setback envelope. For a concave lot it trims
slightly more than the code strictly requires — the safe direction to err.

**The front lot line is the one nearest a street centreline.** The furthest is
the rear; the rest are sides. When no street centreline is available the app
applies the *largest* required yard to every lot line and says so in the
derivation. That is conservative, and usually understates the buildable area.

**Lot area is measured from the mapped boundary, not from the deed.** When the
assessor's recorded area and the mapped boundary disagree by more than 10%, the
app says so rather than picking one.

## Address-matching assumptions

**The street suffix is loosened if the strict match misses.** Assessors record
the same lot as "5 MONUMENT SQ", "5 MONUMENT SQUARE" or just "5 MONUMENT", so
after an exact prefix search fails the suffix is dropped and the search
repeated. If that looser pattern matches several different lots, the app asks
which one rather than picking.

**An address that geocodes outside every parcel falls back to the nearest one
within 300 ft.** Addresses on squares, plazas, pedestrian ways and long
private drives geocode into the public right-of-way, which is not a parcel.
The lot is still adjacent, so the nearest one is used — and the result says so
and asks you to confirm on the map. Beyond 300 ft the app gives up instead.

## Estimating when the district's own standard is unavailable

**An estimate is always produced.** The tool's purpose is a hypothetical, so
"not determined" is never the answer for height, footprint, floor area or
units. When a parcel's own standard is missing — the district is not in the
rule dataset, the zoning layer returned nothing, or the district's table
leaves the value blank — the value comes from **family defaults** in
`data/rules/portland-me.json` (`estimateDefaults`), chosen by the district's
family: residential, mixed-use, business, industrial, institutional, island,
other, or unknown. The family is inferred from Portland's district naming
pattern (`R-*` residential, `B-*` business, `I-*` industrial, `IR-*` island…).

Every figure taken from a default is labelled **our assumption** on screen,
the trace names each estimated field, and a constraint says which district
was unrecognised and how to add it. A district that *is* in the dataset and
states no density cap keeps that — only an unknown district borrows one.

**The community-need pathway is always shown** alongside the base estimate:
what state law (30-A M.R.S. §4364) obliges the city to allow for an
affordable housing development — at least one storey or 14 ft more, 2.5× the
density. It applies only if the project qualifies, and the page says so.

**A lot the setbacks swallow entirely** is still estimated, at its coverage
cap, with a blocking constraint saying a dimensional variance would be needed.

## Rule-application assumptions

**The most restrictive rule governs.** Where the base district, an overlay, and
a height published on the zoning layer all apply, the smallest number wins.

**A height published on the city's own zoning layer beats the transcribed
table.** It is the city's data for that specific polygon; the table is a
transcription.

**Footprint is the smaller of the setback envelope and the lot coverage cap.**
When coverage governs, the shape drawn on the map is the setback envelope and
the building must be smaller than it. The page says so.

**Unit count is the smaller of the density cap and what the floor area
supports.** It is the softest number in the result and is presented that way.

**The state affordable-housing pathway is a separate scenario, never folded
into the base answer.** It applies only if a project actually qualifies under
30-A M.R.S. §4364, which is not something the app can determine.

**A missing rule produces a labelled estimate, never a silent default.** See
the section above: the number always appears, and its badge says what it is.

## What "best" means here

The largest plausible *conforming* residential envelope calculable from the
available zoning, parcel and site data, **without any consideration of
economics**. It ignores construction cost, financing, market rents, land price,
and whether anyone would want to build it.

## What this is not

Not a zoning determination, not a permit, not legal advice, and not a promise
that anything is buildable. Only the City of Portland's Planning & Urban
Development Department can tell you what may actually be built on a parcel.
