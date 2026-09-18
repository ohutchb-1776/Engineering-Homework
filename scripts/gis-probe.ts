/**
 * Prints what the City of Portland's GIS is actually serving right now.
 *
 *   npm run gis:probe
 *   npm run gis:probe -- "389 Congress St"
 *
 * Run this first whenever the app starts reporting layers as unavailable, or
 * whenever you are setting the endpoint environment variables for a new
 * deployment. It reports, per layer, whether it resolves, what it is called,
 * and which of the field names the app looks for it actually has — which is
 * exactly what you need to fix src/lib/gis/config.ts or src/lib/gis/fields.ts.
 */
import { LAYERS, type LayerRef } from "../src/lib/gis/config";
import { getLayerInfo, queryLayer } from "../src/lib/gis/arcgis";
import { FIELD_CANDIDATES, resolveField, type FieldConcept } from "../src/lib/gis/fields";
import { runAnalysis } from "../src/lib/engine/run";

const CONCEPTS_BY_LAYER: Partial<Record<string, FieldConcept[]>> = {
  parcels: ["address", "parcelId", "lotAreaSf", "landUse"],
  zoning: ["zoningDistrict", "zoningName", "maxHeightFt"],
  overlays: ["overlayName"],
  shoreland: ["overlayName"],
  stream: ["overlayName"],
  coastalStability: ["overlayName"],
  historic: ["overlayName"],
  flood: ["floodZone"],
  streets: ["streetName"],
};

async function probe(layer: LayerRef): Promise<boolean> {
  process.stdout.write(`\n${layer.key}${layer.required ? " (required)" : ""}\n  ${layer.url}\n`);
  try {
    const info = await getLayerInfo(layer.url);
    console.log(`  OK  "${info.name}" — ${info.geometryType ?? "unknown geometry"}, ${info.fields.length} fields`);

    for (const concept of CONCEPTS_BY_LAYER[layer.key] ?? []) {
      const resolved = resolveField(info.fields, concept);
      if (resolved) {
        console.log(`      ${concept}: ${resolved}`);
      } else {
        console.log(
          `      ${concept}: NOT FOUND — looked for ${FIELD_CANDIDATES[concept].join(", ")}`,
        );
        console.log(`        available: ${info.fields.map((f) => f.name).join(", ")}`);
      }
    }

    const sample = await queryLayer(layer.url, { where: "1=1", resultRecordCount: 1, returnGeometry: false });
    console.log(`      sample query returned ${sample.length} feature(s)`);
    return true;
  } catch (error) {
    console.log(`  FAIL  ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function main() {
  console.log("Probing the layers this app depends on.\n");
  console.log("Anything marked FAIL needs its endpoint overridden — see .env.example.");

  let requiredFailures = 0;
  for (const layer of Object.values(LAYERS)) {
    const ok = await probe(layer);
    if (!ok && layer.required) requiredFailures += 1;
  }

  const address = process.argv.slice(2).join(" ").trim();
  if (address) {
    console.log(`\n\nEnd-to-end analysis of "${address}":\n`);
    const outcome = await runAnalysis(address);
    if (!outcome.ok) {
      console.log(`  FAILED (${outcome.kind}): ${outcome.message}`);
    } else {
      const base = outcome.result.scenarios[0]!;
      console.log(`  matched:   ${outcome.result.address.matched}`);
      console.log(`  district:  ${outcome.result.zoning.districtCode ?? "unknown"}`);
      console.log(`  lot area:  ${outcome.result.parcel.lotAreaSf.value ?? "?"} sf`);
      console.log(`  height:    ${base.envelope.maxHeightFt.value ?? "?"} ft`);
      console.log(`  storeys:   ${base.envelope.stories.value ?? "?"}`);
      console.log(`  footprint: ${base.envelope.maxFootprintSf.value ?? "?"} sf`);
      console.log(`  units:     ${base.envelope.estimatedUnits.value ?? "?"}`);
      if (outcome.result.gaps.length > 0) {
        console.log("  gaps:");
        for (const gap of outcome.result.gaps) console.log(`    - ${gap}`);
      }
    }
  }

  if (requiredFailures > 0) {
    console.error(`\n${requiredFailures} required layer(s) unreachable.`);
    process.exit(1);
  }
}

void main();
