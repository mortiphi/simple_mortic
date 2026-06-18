import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const outputDir = path.resolve("dist", "desktop", "desktop");
await mkdir(outputDir, { recursive: true });
await copyFile(path.resolve("src", "desktop", "preload.cjs"), path.join(outputDir, "preload.cjs"));
