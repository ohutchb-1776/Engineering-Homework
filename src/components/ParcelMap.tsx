"use client";

/**
 * The parcel and the hypothetical envelope, on an OpenStreetMap raster
 * basemap. MapLibre needs no API key for raster tiles, which keeps the app
 * free of credentials entirely.
 */
import { useEffect, useRef } from "react";
// MapLibre GL v6 ships named exports only; there is no default export.
import {
  Map as MapLibreMap,
  NavigationControl,
  type LngLatBoundsLike,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

export interface ParcelMapProps {
  parcel: GeoJSON.Geometry;
  envelope: GeoJSON.Geometry | null;
}

export function ParcelMap({ parcel, envelope }: ParcelMapProps) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;

    const map = new MapLibreMap({
      container: container.current,
      style: OSM_STYLE,
      center: [-70.2568, 43.6591],
      zoom: 17,
      attributionControl: { compact: true },
    });
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      map.addSource("parcel", { type: "geojson", data: feature(parcel) });
      map.addLayer({
        id: "parcel-fill",
        type: "fill",
        source: "parcel",
        paint: { "fill-color": "#4da3ff", "fill-opacity": 0.12 },
      });
      map.addLayer({
        id: "parcel-line",
        type: "line",
        source: "parcel",
        paint: { "line-color": "#4da3ff", "line-width": 2 },
      });

      if (envelope) {
        map.addSource("envelope", { type: "geojson", data: feature(envelope) });
        map.addLayer({
          id: "envelope-fill",
          type: "fill",
          source: "envelope",
          paint: { "fill-color": "#7dd3a8", "fill-opacity": 0.4 },
        });
        map.addLayer({
          id: "envelope-line",
          type: "line",
          source: "envelope",
          paint: { "line-color": "#7dd3a8", "line-width": 2 },
        });
      }

      const bounds = boundsOf(parcel);
      if (bounds) map.fitBounds(bounds, { padding: 48, duration: 0, maxZoom: 19 });
    });

    return () => map.remove();
  }, [parcel, envelope]);

  return (
    <div className="overflow-hidden rounded-xl border border-[color:var(--color-line)]">
      <div ref={container} className="h-72 w-full" role="img" aria-label="Parcel boundary and the hypothetical building footprint" />
    </div>
  );
}

function feature(geometry: GeoJSON.Geometry): GeoJSON.Feature {
  return { type: "Feature", properties: {}, geometry };
}

function boundsOf(geometry: GeoJSON.Geometry): LngLatBoundsLike | null {
  const positions = collect(geometry);
  if (positions.length === 0) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of positions) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return [
    [minLon, minLat],
    [maxLon, maxLat],
  ];
}

function collect(geometry: GeoJSON.Geometry): [number, number][] {
  if (geometry.type === "Polygon") {
    return geometry.coordinates.flat().map(([lon, lat]) => [lon, lat] as [number, number]);
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.flat(2).map(([lon, lat]) => [lon, lat] as [number, number]);
  }
  return [];
}
