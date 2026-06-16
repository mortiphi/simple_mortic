#!/usr/bin/env node
import { readJson, validateDeltaSet } from "./canonical_state_lib.mjs";

const deltaPath = process.argv[2];
const inputPath = process.argv[3];
if (!deltaPath) {
  console.error("Usage: node scripts/validate_delta.mjs delta-set.json [input.json]");
  process.exit(2);
}

const deltaSet = await readJson(deltaPath);
const input = inputPath ? await readJson(inputPath) : {};
const result = validateDeltaSet(deltaSet, input);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.valid) process.exit(1);
