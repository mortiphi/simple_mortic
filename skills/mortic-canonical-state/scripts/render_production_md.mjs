#!/usr/bin/env node
import { readJson, renderProductionMarkdown } from "./canonical_state_lib.mjs";

const productionPath = process.argv[2];
if (!productionPath) {
  console.error("Usage: node scripts/render_production_md.mjs production.json");
  process.exit(2);
}

process.stdout.write(`${renderProductionMarkdown(await readJson(productionPath))}\n`);
