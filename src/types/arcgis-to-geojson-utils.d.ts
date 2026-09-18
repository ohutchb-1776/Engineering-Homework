/**
 * `@esri/arcgis-to-geojson-utils` ships no type declarations. We only use the
 * one function, so declare exactly that rather than pulling in a shim package.
 */
declare module "@esri/arcgis-to-geojson-utils" {
  import type { GeoJSON } from "geojson";
  export function arcgisToGeoJSON(arcgis: unknown, idAttribute?: string): GeoJSON;
  export function geojsonToArcGIS(geojson: unknown, idAttribute?: string): unknown;
}
