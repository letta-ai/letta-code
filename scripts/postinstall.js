import { chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repairSharpNativeBinding } from "./sharp-native-repair.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(__dirname);
const require = createRequire(import.meta.url);

// A missing sharp binding makes all image handling unusable, so this repair is
// intentionally fatal when a supported platform package cannot be restored.
await repairSharpNativeBinding({ projectRoot: pkgRoot });

try {
  await import("./postinstall-patches.js");
} catch (error) {
  console.warn("letta: vendor patches skipped:", error?.message || error);
}

try {
  chmodSync(
    join(
      require.resolve("node-pty/package.json"),
      "../prebuilds/darwin-arm64/spawn-helper",
    ),
    0o755,
  );
} catch {}
