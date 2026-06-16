import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export async function previewFile(filePath: string | undefined, maxChars = 24_000): Promise<string | undefined> {
  if (!filePath || !existsSync(filePath)) return undefined;
  const text = await readFile(filePath, "utf8");
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars / 2));
  const tail = text.slice(text.length - Math.floor(maxChars / 2));
  return `${head}\n\n[... ${text.length - maxChars} chars omitted ...]\n\n${tail}`;
}

export async function writeAtomic(filePath: string, text: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  await writeFile(tempPath, text, "utf8");
  await mkdir(dir, { recursive: true });
  await rename(tempPath, filePath);
}

export function serializeOperations() {
  let queue: Promise<unknown> = Promise.resolve();

  return async function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.then(operation, operation);
    queue = run.catch(() => undefined);
    return await run;
  };
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}
