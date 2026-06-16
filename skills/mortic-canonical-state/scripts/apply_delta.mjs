#!/usr/bin/env node
import { applyApprovedDeltas, readJson } from "./canonical_state_lib.mjs";

const [productionPath, deltaPath, approvedPath] = process.argv.slice(2);
if (!productionPath || !deltaPath || !approvedPath) {
  console.error("Usage: node scripts/apply_delta.mjs production.json delta-set.json approved-ids.json");
  process.exit(2);
}

const production = await readJson(productionPath);
const deltaSet = await readJson(deltaPath);
const approvedIds = await readJson(approvedPath);
process.stdout.write(`${JSON.stringify(applyApprovedDeltas(production, deltaSet, approvedIds), null, 2)}\n`);
