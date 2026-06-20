import { chmodSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const launcherPath = path.join(homedir(), "Desktop", "Simple Mortic.command");
const launchScript = path.join(repoDir, "scripts", "launch_desktop.sh");
const shQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

const launcher = `#!/usr/bin/env bash
set -euo pipefail

cd ${shQuote(repoDir)}
exec ${shQuote(launchScript)}
`;

writeFileSync(launcherPath, launcher, "utf8");
chmodSync(launcherPath, 0o755);

console.log(`Installed Desktop launcher: ${launcherPath}`);
