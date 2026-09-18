/**
 * Synthetic parcels.
 *
 * The engine is tested against geometry we can do by hand, not against live
 * GIS. That keeps the tests deterministic and keeps a city server outage from
 * turning into a red build.
 */
import type { Feature, Polygon } from "geojson";
import area from "@turf/area";
import { SQ_FT_PER_SQ_M } from "../../src/lib/gis/site";
import type { SiteData, OverlayHit } from "../../src/lib/gis/site";
import { makeProjector, type LonLat } from "../../src/lib/geometry/project";

/** Centre of the Portland peninsula, near Congress Street. */
export const PORTLAND_ORIGIN: LonLat = [-70.2568, 43.6591];

/**
 * A rectangular lot `widthFt` along the street by `depthFt` deep, anchored at
 * `origin`. Vertex 0 is the street-facing corner and edge 0 runs along the
 * street, so a street line placed south of the lot makes edge 0 the frontage.
 */
export function rectangularLot(
  widthFt: number,
  depthFt: number,
  origin: LonLat = PORTLAND_ORIGIN,
): Feature<Polygon, Record<string, unknown>> {
  const projector = makeProjector(origin);

  const build = (scale: number): Feature<Polygon, Record<string, unknown>> => {
    const w = widthFt * scale;
    const d = depthFt * scale;
    const corners: [number, number][] = [
      [0, 0],
      [w, 0],
      [w, d],
      [0, d],
      [0, 0],
    ];
    return {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        // `corners` are already in feet, so they only need unprojecting.
        coordinates: [corners.map((corner) => [...projector.toLonLat(corner)])],
      },
    };
  };

  // The projection is ellipsoidal but @turf/area is spherical, so a lot built
  // at its nominal size measures about 0.2% small. Tests are far easier to read
  // when "a 100 x 100 ft lot" really does measure 10,000 sf, so nudge the
  // corners until the measured area matches. Two steps converge to <1e-9.
  const target = widthFt * depthFt;
  let scale = 1;
  for (let i = 0; i < 2; i++) {
    const measured = area(build(scale)) * SQ_FT_PER_SQ_M;
    scale *= Math.sqrt(target / measured);
  }
  return build(scale);
}

/** A street centreline running east-west, `offsetFt` south of the lot origin. */
export function streetSouthOf(origin: LonLat, offsetFt: number, lengthFt = 400): LonLat[] {
  const projector = makeProjector(origin);
  return [
    projector.toLonLat([-lengthFt / 2, -offsetFt]),
    projector.toLonLat([lengthFt / 2, -offsetFt]),
  ];
}

export interface FakeSiteOptions {
  widthFt?: number;
  depthFt?: number;
  districtCode?: string | null;
  mappedMaxHeightFt?: number | null;
  overlays?: OverlayHit[];
  withStreet?: boolean;
  recordedAreaSf?: number | null;
  gaps?: string[];
}

export function fakeSite(options: FakeSiteOptions = {}): SiteData {
  const {
    widthFt = 100,
    depthFt = 100,
    districtCode = "R-6",
    mappedMaxHeightFt = null,
    overlays = [],
    withStreet = true,
    recordedAreaSf = null,
    gaps = [],
  } = options;

  const feature = rectangularLot(widthFt, depthFt);
  const projector = makeProjector(PORTLAND_ORIGIN);
  const centroidPoint = projector.toLonLat([widthFt / 2, depthFt / 2]);
  // Measure the fixture the same way the pipeline measures a real parcel, so
  // the geometry and the stated area cannot drift apart.
  const computedAreaSf = area(feature) * SQ_FT_PER_SQ_M;

  return {
    parcel: {
      feature,
      address: "123 EXAMPLE ST",
      parcelId: "TEST-0001",
      computedAreaSf,
      recordedAreaSf,
      centroid: centroidPoint,
    },
    zoning: {
      districtCode,
      districtName: null,
      mappedMaxHeightFt,
      rawValues: districtCode ? [districtCode] : [],
      method: districtCode ? "parcel" : "none",
    },
    overlays,
    streetLines: withStreet ? [streetSouthOf(PORTLAND_ORIGIN, 20)] : [],
    sources: [],
    gaps,
    matchMethod: "parcel-address-field",
    matchedAddress: "123 EXAMPLE ST",
  };
}
