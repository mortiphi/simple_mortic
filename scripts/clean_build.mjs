import { rm } from "node:fs/promises";
import path from "node:path";

const targets = new Map([
  ["node-client", [path.join("dist", "node"), path.join("dist", "client")]],
  ["desktop", [path.join("dist", "desktop")]],
  ["release", [path.join("release")]],
  ["all", [path.join("dist", "node"), path.join("dist", "client"), path.join("dist", "desktop"), path.join("release")]]
]);

const target = process.argv[2] ?? "all";
const paths = targets.get(target);

if (!paths) {
  console.error(`Unknown clean target: ${target}`);
  console.error(`Expected one of: ${Array.from(targets.keys()).join(", ")}`);
  process.exit(1);
}

await Promise.all(paths.map((entry) => rm(path.resolve(entry), { force: true, recursive: true })));
