/**
 * Checks the rule dataset for the things a reviewer would check by eye, and
 * prints what still needs verifying against the published code.
 *
 *   npm run rules:lint
 */
import { ruleSet } from "../src/lib/rules/load";
import type { Sourced } from "../src/lib/rules/schema";

const problems: string[] = [];
const citationIds = new Set(ruleSet.citations.map((c) => c.id));

let total = 0;
let verified = 0;
let needsVerification = 0;
let notStated = 0;

function check(path: string, value: Sourced<unknown>) {
  total += 1;
  if (!citationIds.has(value.source)) problems.push(`${path}: unknown citation "${value.source}"`);
  if (value.value === null && value.confidence !== "not-stated") {
    problems.push(`${path}: null value should be marked "not-stated"`);
  }
  if (value.value !== null && value.confidence === "not-stated") {
    problems.push(`${path}: has a value but is marked "not-stated"`);
  }
  if (value.confidence === "verified") verified += 1;
  else if (value.confidence === "needs-verification") needsVerification += 1;
  else notStated += 1;
}

for (const d of ruleSet.districts) {
  check(`${d.code}.multifamilyAllowed`, d.multifamilyAllowed);
  check(`${d.code}.maxHeightFt`, d.maxHeightFt);
  check(`${d.code}.maxStories`, d.maxStories);
  check(`${d.code}.minLotAreaSf`, d.minLotAreaSf);
  check(`${d.code}.minLotAreaPerDwellingSf`, d.minLotAreaPerDwellingSf);
  check(`${d.code}.maxFar`, d.maxFar);
  check(`${d.code}.maxLotCoverageRatio`, d.maxLotCoverageRatio);
  check(`${d.code}.minStreetFrontageFt`, d.minStreetFrontageFt);
  check(`${d.code}.parkingSpacesPerDwelling`, d.parkingSpacesPerDwelling);
  check(`${d.code}.minYardsFt.front`, d.minYardsFt.front);
  check(`${d.code}.minYardsFt.side`, d.minYardsFt.side);
  check(`${d.code}.minYardsFt.rear`, d.minYardsFt.rear);
}

for (const o of ruleSet.overlays) {
  if (!citationIds.has(o.citation)) problems.push(`overlay ${o.id}: unknown citation "${o.citation}"`);
  for (const [key, effect] of Object.entries(o.effect)) {
    if (effect) check(`overlay ${o.id}.${key}`, effect as Sourced<unknown>);
  }
}

for (const p of ruleSet.statutePathways) {
  if (!citationIds.has(p.source)) problems.push(`statute ${p.id}: unknown citation "${p.source}"`);
}

const unverifiedDistricts = ruleSet.districts
  .filter((d) => d.maxHeightFt.confidence === "needs-verification")
  .map((d) => d.code);

console.log(`Rule dataset v${ruleSet.version} — ${ruleSet.codeEdition}`);
console.log(`  districts: ${ruleSet.districts.length}`);
console.log(`  overlays:  ${ruleSet.overlays.length}`);
console.log(`  citations: ${ruleSet.citations.length}`);
console.log(
  `  values:    ${total} (${verified} verified, ${needsVerification} need verification, ${notStated} not stated)`,
);

if (!ruleSet.provenance.verifiedAgainstPrimarySource) {
  console.log("");
  console.log("  NOT VERIFIED against the primary source.");
  console.log(`  ${ruleSet.provenance.warning}`);
  if (unverifiedDistricts.length > 0) {
    console.log(`  Districts whose height still needs checking: ${unverifiedDistricts.join(", ")}`);
  }
}

if (problems.length > 0) {
  console.error("");
  console.error(`${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log("");
console.log("Dataset is structurally sound.");
