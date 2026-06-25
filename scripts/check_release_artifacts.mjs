import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const releaseDir = path.resolve("release");

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function shellOut(command, args) {
  return execFileSync(command, args, { encoding: "utf8" });
}

async function findArtifacts(ext) {
  if (!existsSync(releaseDir)) return [];
  return (await readdir(releaseDir))
    .filter((entry) => entry.endsWith(ext))
    .map((entry) => path.join(releaseDir, entry));
}

async function checkLinuxUnpacked() {
  const sandboxPath = path.join(releaseDir, "linux-unpacked", "chrome-sandbox");
  if (!existsSync(sandboxPath)) return;

  const mode = (await stat(sandboxPath)).mode & 0o7777;
  if (mode !== 0o4755) {
    fail(`Expected ${sandboxPath} mode 4755, got ${mode.toString(8)}`);
  }
}

function assertSandboxLine(kind, artifact, line) {
  if (!line) {
    fail(`${kind} ${artifact} does not contain chrome-sandbox`);
    return;
  }
  if (!line.startsWith("-rwsr-xr-x")) {
    fail(`${kind} ${artifact} has unexpected chrome-sandbox permissions: ${line.trim()}`);
  }
}

async function checkDebs() {
  for (const artifact of await findArtifacts(".deb")) {
    const contents = shellOut("dpkg-deb", ["-c", artifact]);
    const line = contents.split("\n").find((entry) => entry.includes("/opt/Mortic/chrome-sandbox"));
    assertSandboxLine("Debian package", artifact, line);
  }
}

async function checkRpms() {
  const rpms = await findArtifacts(".rpm");
  if (rpms.length === 0) return;

  for (const artifact of rpms) {
    const contents = shellOut("rpm", ["-qplv", artifact]);
    const line = contents.split("\n").find((entry) => entry.includes("/opt/Mortic/chrome-sandbox"));
    assertSandboxLine("RPM package", artifact, line);
  }
}

await checkLinuxUnpacked();
await checkDebs();
await checkRpms();

if (process.exitCode) process.exit(process.exitCode);

console.log("Release artifact checks passed");
