const { chmod } = require("node:fs/promises");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "linux") return;

  const sandboxPath = path.join(context.appOutDir, "chrome-sandbox");
  try {
    await chmod(sandboxPath, 0o4755);
  } catch (error) {
    throw new Error(`Failed to set chrome-sandbox permissions at ${sandboxPath}: ${error.message}`);
  }
};
