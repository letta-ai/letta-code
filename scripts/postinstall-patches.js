// Postinstall patcher for vendoring our Ink modifications without patch-package.
// Copies patched runtime files from ./src/vendor into node_modules.

import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(__dirname);
const require = createRequire(import.meta.url);

async function copyToResolved(srcRel, targetSpecifier) {
  const src = join(pkgRoot, srcRel);
  if (!existsSync(src)) return;
  let dest;
  try {
    // Special handling for Ink internals due to package exports
    if (targetSpecifier.startsWith("ink/")) {
      // Resolve root of installed ink package; add robust fallbacks for Bun
      let buildDir;
      try {
        // Prefer import.meta.resolve when available
        const inkEntryUrl = await import.meta.resolve("ink");
        const inkEntryPath = fileURLToPath(inkEntryUrl); // .../node_modules/ink/build/index.js
        buildDir = dirname(inkEntryPath); // .../node_modules/ink/build
      } catch {}
      if (!buildDir) {
        try {
          const inkPkgPath = require.resolve("ink/package.json");
          const inkRoot = dirname(inkPkgPath);
          buildDir = join(inkRoot, "build");
        } catch {}
      }
      if (!buildDir) {
        // Final fallback: assume standard layout relative to project root
        buildDir = join(pkgRoot, "node_modules", "ink", "build");
      }
      const rel = targetSpecifier.replace(/^ink\//, ""); // e.g. build/components/App.js
      const afterBuild = rel.replace(/^build\//, ""); // e.g. components/App.js
      dest = join(buildDir, afterBuild);
    } else if (targetSpecifier.startsWith("ink-text-input/")) {
      // Resolve root of installed ink-text-input in a Node 18+ compatible way
      try {
        const entryUrl = await import.meta.resolve("ink-text-input");
        dest = fileURLToPath(entryUrl); // .../node_modules/ink-text-input/build/index.js
      } catch {
        try {
          const itPkgPath = require.resolve("ink-text-input/package.json");
          const itRoot = dirname(itPkgPath);
          dest = join(itRoot, "build", "index.js");
        } catch {
          // Final fallback
          dest = join(
            pkgRoot,
            "node_modules",
            "ink-text-input",
            "build",
            "index.js",
          );
        }
      }
    } else {
      dest = require.resolve(targetSpecifier);
    }
  } catch (e) {
    console.warn(
      `[patch] failed to resolve ${targetSpecifier}:`,
      e?.message || e,
    );
    return;
  }
  const destDir = dirname(dest);
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  try {
    copyFileSync(src, dest);
    console.log(`[patch] ${srcRel} -> ${dest}`);
  } catch (e) {
    console.warn(
      `[patch] failed to copy ${srcRel} to ${dest}:`,
      e?.message || e,
    );
  }
}

// Ink internals (resolve actual installed module path)
await copyToResolved(
  "vendor/ink/build/components/App.js",
  "ink/build/components/App.js",
);
await copyToResolved(
  "vendor/ink/build/hooks/use-input.js",
  "ink/build/hooks/use-input.js",
);
await copyToResolved("vendor/ink/build/devtools.js", "ink/build/devtools.js");
await copyToResolved("vendor/ink/build/log-update.js", "ink/build/log-update.js");

// ink-text-input (optional vendor with externalCursorOffset support)
await copyToResolved(
  "vendor/ink-text-input/build/index.js",
  "ink-text-input/build/index.js",
);

console.log("[patch] Ink runtime patched");

// On Unix with Bun available, use polyglot shebang to prefer Bun runtime.
// This enables Bun.secrets for secure keychain storage instead of fallback.
// Windows always uses #!/usr/bin/env node (polyglot shebang breaks npm wrappers).
if (process.platform !== "win32") {
  try {
    execSync("bun --version", { stdio: "ignore" });
    const lettaPath = join(pkgRoot, "letta.js");
    if (existsSync(lettaPath)) {
      let content = readFileSync(lettaPath, "utf-8");
      if (content.startsWith("#!/usr/bin/env node")) {
        content = content.replace(
          "#!/usr/bin/env node",
          `#!/bin/sh
":" //#; exec /usr/bin/env sh -c 'command -v bun >/dev/null && exec bun "$0" "$@" || exec node "$0" "$@"' "$0" "$@"`,
        );
        writeFileSync(lettaPath, content);
        console.log("[patch] Configured letta to prefer Bun runtime");
      }
    }
  } catch {
    // Bun not available, keep node shebang
  }
}
