#!/usr/bin/env node

import { readFileSync } from "node:fs";

const inputPath = process.argv[2];
const raw = inputPath ? readFileSync(inputPath, "utf8") : readFileSync(0, "utf8");
const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

if (/(^|\n)\s*(SPEAK|READ):\s*/i.test(raw)) fail("Output must not contain SPEAK:/READ: labels.");
if (/<\/?(say|notes|sources)>/i.test(raw)) fail("Output must not contain legacy XML-style voice tags.");

const lines = raw
  .replace(/\r\n/g, "\n")
  .split("\n")
  .filter((line) => line.trim().length > 0);

if (lines.length !== 2) {
  fail(`Expected exactly 2 non-empty NDJSON lines, found ${lines.length}.`);
}

const parsed = lines.map((line, index) => {
  try {
    return JSON.parse(line);
  } catch (error) {
    fail(`Line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
});

const speak = parsed[0];
const read = parsed[1];

if (speak !== undefined) {
  if (!speak || typeof speak !== "object" || Array.isArray(speak)) {
    fail("Line 1 must be a JSON object.");
  } else {
    if (speak.type !== "speak") fail('Line 1 must have type "speak".');
    if (typeof speak.text !== "string") fail('Line 1 must have string field "text".');
    const allowed = new Set(["type", "text"]);
    for (const key of Object.keys(speak)) {
      if (!allowed.has(key)) fail(`Line 1 has unexpected field "${key}".`);
    }
  }
}

if (read !== undefined) {
  if (!read || typeof read !== "object" || Array.isArray(read)) {
    fail("Line 2 must be a JSON object.");
  } else {
    if (read.type !== "read") fail('Line 2 must have type "read".');
    if (typeof read.markdown !== "string") fail('Line 2 must have string field "markdown".');
    const allowed = new Set(["type", "markdown"]);
    for (const key of Object.keys(read)) {
      if (!allowed.has(key)) fail(`Line 2 has unexpected field "${key}".`);
    }
  }
}

if (speak && typeof speak === "object" && typeof speak.text === "string") {
  const text = speak.text;
  if (!text.trim()) warn("speak.text is empty.");
  if (text.length > 1200) warn(`speak.text is long (${text.length} characters); keep it conversational and concise, but do not hide the answer in read.markdown.`);
  if (/```|`[^`]+`/.test(text)) warn("speak.text appears to contain code or inline code.");
  if (/\bhttps?:\/\/\S+/i.test(text)) warn("speak.text contains a URL.");
  if (/(^|\s)\/[^\s,;:()]+(?:\/[^\s,;:()]+)+/.test(text)) warn("speak.text appears to contain an absolute file path.");
  if (/(^|\n)\s*(?:[-*]\s+|\d+[.)]\s+)/.test(text)) warn("speak.text appears to contain a list.");
  if (/\$[\d.]+\s*\/\s*(?:1\s*)?[KM]\s*(?:chars?|characters?)?/i.test(text)) {
    warn("speak.text contains slash pricing; say 'per thousand characters' or 'per million characters'.");
  }
  if (/\bchars?\b/i.test(text)) warn("speak.text contains 'chars'; say 'characters'.");
  if (/\b(?:TTS|STT|S2S)\b/.test(text)) warn("speak.text contains an acronym that may be awkward for speech.");
}

for (const warning of warnings) {
  console.error(`WARN: ${warning}`);
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`ERROR: ${error}`);
  }
  process.exit(1);
}

console.log(warnings.length > 0 ? `Valid with ${warnings.length} warning(s).` : "Valid Mortic voice NDJSON.");
