/**
 * Prints where the app's layers actually resolve to right now, and why.
 *
 *   npm run gis:probe
 *   npm run gis:probe -- "389 Congress St"
 *
 * The app discovers its endpoints at run time (see src/lib/gis/discovery.ts),
 * so this is not a list of guesses — it is what the app would use. Run it when
 * addresses stop resolving. Anything reported UNRESOLVED needs its environment
 * variable set; everything else is already working.
 *
 * The same report is available in a browser at /diagnostics, which is the one
 * to use when the app works locally but not on the deployed host.
 */
import { resolveAllLayers } from "../src/lib/gis/discovery";
import { getLayerInfo, queryLayer } from "../src/lib/gis/arcgis";
import { FIELD_CANDIDATES, resolveField, type FieldConcept } from "../src/lib/gis/fields";
import { LAYER_SPEC_BY_KEY } from "../src/lib/gis/config";
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

async function main() {
  console.log("Resolving every layer the app depends on.\n");

  const resolved = await resolveAllLayers(true);
  let requiredFailures = 0;

  for (const layer of resolved) {
    console.log(`\n${layer.key}${layer.required ? " (required)" : ""} — ${layer.label}`);

    if (!layer.url) {
      console.log("  UNRESOLVED. Tried:");
      for (const attempt of layer.attempts) console.log(`    ${attempt.url}\n      ${attempt.outcome}`);
      console.log(`  Fix: set ${LAYER_SPEC_BY_KEY[layer.key]?.envVar} to a working layer URL.`);
      if (layer.required) requiredFailures += 1;
      continue;
    }

    console.log(`  ${layer.url}`);
    console.log(`  found via ${layer.via}${layer.serverName ? ` — "${layer.serverName}"` : ""}`);

    try {
      const info = await getLayerInfo(layer.url);
      for (const concept of CONCEPTS_BY_LAYER[layer.key] ?? []) {
        const field = resolveField(info.fields, concept);
        if (field) {
          console.log(`    ${concept}: ${field}`);
        } else {
          console.log(`    ${concept}: NOT FOUND — looked for ${FIELD_CANDIDATES[concept].join(", ")}`);
          console.log(`      available: ${info.fields.map((f) => f.name).join(", ")}`);
        }
      }
      const sample = await queryLayer(layer.url, {
        where: "1=1",
        resultRecordCount: 1,
        returnGeometry: false,
      });
      console.log(`    sample query returned ${sample.length} feature(s)`);
    } catch (error) {
      console.log(`    could not read it: ${error instanceof Error ? error.message : String(error)}`);
      if (layer.required) requiredFailures += 1;
    }
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
      for (const gap of outcome.result.gaps) console.log(`  gap: ${gap}`);
    }
  }

  if (requiredFailures > 0) {
    console.error(`\n${requiredFailures} required layer(s) unusable.`);
    process.exit(1);
  }
  console.log("\nAll required layers resolved.");
}

void main();
