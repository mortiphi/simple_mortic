#!/usr/bin/env node
import { extractDeltaSet, readJson } from "./canonical_state_lib.mjs";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/extract_state_delta.mjs input.json");
  process.exit(2);
}

const input = await readJson(inputPath);
process.stdout.write(`${JSON.stringify(extractDeltaSet(input), null, 2)}\n`);
