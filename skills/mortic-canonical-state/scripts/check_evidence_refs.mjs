#!/usr/bin/env node
import { inputText, readJson, validateDeltaSet } from "./canonical_state_lib.mjs";

const [deltaPath, inputPath] = process.argv.slice(2);
if (!deltaPath || !inputPath) {
  console.error("Usage: node scripts/check_evidence_refs.mjs delta-set.json input.json");
  process.exit(2);
}

const deltaSet = await readJson(deltaPath);
const input = await readJson(inputPath);
const result = validateDeltaSet(deltaSet, input);
const transcriptBytes = Buffer.byteLength(inputText(input), "utf8");
process.stdout.write(`${JSON.stringify({ transcriptBytes, valid: result.valid, errors: result.errors }, null, 2)}\n`);
if (!result.valid) process.exit(1);
