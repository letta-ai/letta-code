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
const packageJson = JSON.parse(
  readFileSync(join(pkgRoot, "package.json"), "utf-8"),
);
const minimumBunVersion = packageJson.engines.bun.replace(/^>=/, "");

function isBunVersionSupported(version) {
  const current = version.split(".").map(Number);
  const minimum = minimumBunVersion.split(".").map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if ((current[index] ?? 0) > (minimum[index] ?? 0)) return true;
    if ((current[index] ?? 0) < (minimum[index] ?? 0)) return false;
  }
  return true;
}

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

async function patchInkRuntime(replacements) {
  let inkBuildDir;
  try {
    inkBuildDir = dirname(fileURLToPath(await import.meta.resolve("ink")));
  } catch {
    try {
      inkBuildDir = join(dirname(require.resolve("ink/package.json")), "build");
    } catch {
      inkBuildDir = join(pkgRoot, "node_modules", "ink", "build");
    }
  }

  const runtimePath = join(inkBuildDir, "ink.js");
  let content = readFileSync(runtimePath, "utf8");
  for (const { before, after, all = false } of replacements) {
    if (all) {
      const candidates = Array.isArray(before) ? before : [before];
      const target = candidates.find((candidate) =>
        content.includes(candidate),
      );
      if (target) {
        content = content.replaceAll(target, after);
        continue;
      }
      if (content.includes(after)) continue;
      throw new Error(
        `[patch] Ink runtime patch target not found in ${runtimePath}`,
      );
    }
    if (content.includes(after)) continue;
    const candidates = Array.isArray(before) ? before : [before];
    const target = candidates.find((candidate) => content.includes(candidate));
    if (!target) {
      throw new Error(
        `[patch] Ink runtime patch target not found in ${runtimePath}`,
      );
    }
    content = content.replace(target, after);
  }
  writeFileSync(runtimePath, content);
  console.log(`[patch] resettable static output -> ${runtimePath}`);
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
await copyToResolved(
  "vendor/ink/build/log-update.js",
  "ink/build/log-update.js",
);
await copyToResolved("vendor/ink/build/wrap-text.js", "ink/build/wrap-text.js");
await patchInkRuntime([
  {
    before:
      "writeToStderr: this.writeToStderr, exitOnCtrlC: this.options.exitOnCtrlC",
    after:
      "writeToStderr: this.writeToStderr, resetStaticOutput: this.resetStaticOutput, exitOnCtrlC: this.options.exitOnCtrlC",
  },
  {
    before: [
      // Current patched state from the 8 MiB follow-up on this branch.
      "    fullStaticOutput;\n    staticOutputRepaintPending = false;\n    isCi = () => isInCi && !this.options.stdout.isTTY;\n    // Cap the retained static transcript tail (in UTF-16 code units). Ink keeps\n    // fullStaticOutput so overflow frames and static repaints can rewrite the\n    // newest tail after a viewport clear. Overflow uses 2J+H (no 3J) so emulator\n    // scrollback keeps older history; 8 MiB is a UX-sized rewrite window (256 KB\n    // is one large Read/git diff) and bounds per-frame write volume. Uncapped,\n    // the string grows with the whole session and is re-serialized on overflow.\n    staticOutputRetainLimit = 8 * 1024 * 1024;\n    retainStaticOutput = (value) => {\n        if (value.length <= this.staticOutputRetainLimit) {\n            return value;\n        }\n        const cut = value.indexOf('\\n', value.length - this.staticOutputRetainLimit);\n        return '\\u001B[0m' + (cut === -1 ? value.slice(value.length - this.staticOutputRetainLimit) : value.slice(cut + 1));\n    };\n    exitPromise;",
      // Current patched state from this PR's first commit (256 KB cap).
      "    fullStaticOutput;\n    staticOutputRepaintPending = false;\n    isCi = () => isInCi && !this.options.stdout.isTTY;\n    // Cap the retained static transcript tail (in UTF-16 code units). Ink keeps\n    // fullStaticOutput so overflow frames and static repaints can rewrite the\n    // transcript after clearing the terminal; uncapped it grows linearly with\n    // the whole session transcript and is re-serialized on every overflow frame.\n    staticOutputRetainLimit = 256 * 1024;\n    retainStaticOutput = (value) => {\n        if (value.length <= this.staticOutputRetainLimit) {\n            return value;\n        }\n        const cut = value.indexOf('\\n', value.length - this.staticOutputRetainLimit);\n        return '\\u001B[0m' + (cut === -1 ? value.slice(value.length - this.staticOutputRetainLimit) : value.slice(cut + 1));\n    };\n    exitPromise;",
      // Current patched state from a previous install (transition path).
      "    fullStaticOutput;\n    staticOutputRepaintPending = false;\n    isCi = () => isInCi && !this.options.stdout.isTTY;\n    exitPromise;",
      "    fullStaticOutput;\n    staticOutputRepaintPending = false;\n    exitPromise;",
      "    fullStaticOutput;\n    exitPromise;",
    ],
    after:
      "    fullStaticOutput;\n    staticOutputRepaintPending = false;\n    isCi = () => isInCi && !this.options.stdout.isTTY;\n    // Cap the retained static transcript tail (in UTF-16 code units). Ink keeps\n    // fullStaticOutput so overflow frames and static repaints can rewrite the\n    // newest tail after a viewport clear. Overflow uses 2J+H (no 3J) so emulator\n    // scrollback keeps older history; 2 MiB is a UX-sized rewrite window (256 KB\n    // is one large Read/git diff) and bounds per-frame write volume. Uncapped,\n    // the string grows with the whole session and is re-serialized on overflow.\n    staticOutputRetainLimit = 2 * 1024 * 1024;\n    retainStaticOutput = (value) => {\n        if (value.length <= this.staticOutputRetainLimit) {\n            return value;\n        }\n        const cut = value.indexOf('\\n', value.length - this.staticOutputRetainLimit);\n        return '\\u001B[0m' + (cut === -1 ? value.slice(value.length - this.staticOutputRetainLimit) : value.slice(cut + 1));\n    };\n    exitPromise;",
  },
  {
    before: "        if (isInCi) {",
    after: "        if (this.isCi()) {",
    all: true,
  },
  {
    before: "        if (!isInCi) {",
    after: "        if (!this.isCi()) {",
  },
  {
    before: "        if (!isInCi && !this.options.debug) {",
    after: "        if (!this.isCi() && !this.options.debug) {",
  },
  {
    before: [
      // Current patched state from a previous install (transition path).
      "        if (this.staticOutputRepaintPending && (this.options.debug || this.isCi())) {\n            if (this.options.stdout.isTTY) {\n                this.fullStaticOutput = hasStaticOutput ? staticOutput : '';\n                this.repaintStaticOutput(output);\n                return;\n            }\n            this.staticOutputRepaintPending = false;\n        }\n        if (this.options.debug) {",
      "        if (this.options.debug) {",
    ],
    after:
      "        if (this.staticOutputRepaintPending && (this.options.debug || this.isCi())) {\n            if (this.options.stdout.isTTY) {\n                this.fullStaticOutput = this.retainStaticOutput(hasStaticOutput ? staticOutput : '');\n                this.repaintStaticOutput(output);\n                return;\n            }\n            this.staticOutputRepaintPending = false;\n        }\n        if (this.options.debug) {",
  },
  {
    // Bound steady-state growth: route every append through the tail cap.
    before: "this.fullStaticOutput += staticOutput;",
    after:
      "this.fullStaticOutput = this.retainStaticOutput(this.fullStaticOutput + staticOutput);",
    all: true,
  },
  {
    // Overflow frames: do not replay fullStaticOutput and do not clear the
    // screen. 2J erases on-screen transcript rows without saving them
    // (xterm.js) or copies every live frame into history (tmux
    // scroll-on-clear). Clip the live output to its last rows - 1 lines
    // (approval/input sit at the bottom of AppView) so log-update's cursor-up
    // region always fits on screen, then take the normal log-update path:
    // new static rows scroll into history above the live region, the live
    // region is rewritten in place, and unchanged frames are skipped.
    // lastOutput keeps the clipped frame, so console redraws and later diffs
    // match the screen. fullStaticOutput stays for the one-shot #4032 repaint.
    before: [
      // Current branch: 2J+H replace of the live tail clipped to rows lines.
      "            if (hasStaticOutput) {\n                this.options.stdout.write(staticOutput + '\\n'.repeat(this.options.stdout.rows || 1));\n            }\n            if (hasStaticOutput || output !== this.lastOutput) {\n                const rows = this.options.stdout.rows || 1;\n                const liveLines = output.split('\\n');\n                this.options.stdout.write('\\u001B[2J\\u001B[H' + (liveLines.length > rows ? liveLines.slice(-rows).join('\\n') : output));\n            }\n            this.lastOutput = output;\n            return;",
      // Earlier: clip kept the top of the live tree (hides input/approval).
      "            if (hasStaticOutput) {\n                this.options.stdout.write(staticOutput + '\\n'.repeat(this.options.stdout.rows || 1));\n            }\n            if (hasStaticOutput || output !== this.lastOutput) {\n                const rows = this.options.stdout.rows || 1;\n                const liveLines = output.split('\\n');\n                this.options.stdout.write('\\u001B[2J\\u001B[H' + (liveLines.length > rows ? liveLines.slice(0, rows).join('\\n') : output));\n            }\n            this.lastOutput = output;\n            return;",
      // Earlier: scroll increment then 2J+H the unclipped live region
      // (still scrolls when outputHeight > rows).
      "            if (hasStaticOutput) {\n                this.options.stdout.write(staticOutput + '\\n'.repeat(this.options.stdout.rows || 1));\n            }\n            if (hasStaticOutput || output !== this.lastOutput) {\n                this.options.stdout.write('\\u001B[2J\\u001B[H' + output);\n            }\n            this.lastOutput = output;\n            return;",
      // Earlier: append increment and live with no viewport replace.
      "            if (hasStaticOutput) {\n                this.options.stdout.write(staticOutput);\n            }\n            if (output !== this.lastOutput) {\n                this.options.stdout.write(output);\n            }\n            this.lastOutput = output;\n            return;",
      // Earlier: increment immediately followed by 2J (erases the item).
      "            if (hasStaticOutput || output !== this.lastOutput) {\n                this.options.stdout.write((hasStaticOutput ? staticOutput : '') + '\\u001B[2J\\u001B[H' + output);\n            }\n            this.lastOutput = output;\n            return;",
      // Earlier: 2J+H but still replayed the retained tail.
      "            if (hasStaticOutput || output !== this.lastOutput) {\n                this.options.stdout.write('\\u001B[2J\\u001B[H' + this.fullStaticOutput + output);\n            }\n            this.lastOutput = output;\n            return;",
      // Earlier: skip-no-change guard still used clearTerminal (3J).
      "            if (hasStaticOutput || output !== this.lastOutput) {\n                this.options.stdout.write(ansiEscapes.clearTerminal + this.fullStaticOutput + output);\n            }\n            this.lastOutput = output;\n            return;",
      // Pristine Ink / earlier patched state: always-rewrite overflow.
      "            this.options.stdout.write(ansiEscapes.clearTerminal + this.fullStaticOutput + output);\n            this.lastOutput = output;\n            return;",
    ],
    after:
      "            const liveOutput = output.split('\\n').slice(-Math.max(1, (this.options.stdout.rows || 1) - 1)).join('\\n');\n            if (hasStaticOutput) {\n                this.log.clear();\n                this.options.stdout.write(staticOutput);\n                this.log(liveOutput);\n            }\n            else if (liveOutput !== this.lastOutput) {\n                this.throttledLog(liveOutput);\n            }\n            this.lastOutput = liveOutput;\n            return;",
  },
  {
    before: "        if (outputHeight >= this.options.stdout.rows) {",
    after:
      "        if (this.staticOutputRepaintPending) {\n            this.repaintStaticOutput(output);\n            return;\n        }\n        if (outputHeight >= this.options.stdout.rows) {",
  },
  {
    before: [
      "    resetStaticOutput = () => {\n        this.fullStaticOutput = '';\n        this.staticOutputRepaintPending = true;\n    };\n    writeToStdout(data) {",
      "    resetStaticOutput = () => {\n        this.fullStaticOutput = '';\n    };\n    writeToStdout(data) {",
      "    writeToStdout(data) {",
    ],
    after:
      "    repaintStaticOutput = (output) => {\n        this.staticOutputRepaintPending = false;\n        const liveOutput = output + '\\n';\n        this.options.stdout.write('\\u001B[?2026h\\u001B[2J\\u001B[H' + this.fullStaticOutput + liveOutput + '\\u001B[?2026l');\n        this.log.sync?.(output);\n        this.lastOutput = output;\n    };\n    resetStaticOutput = () => {\n        this.fullStaticOutput = '';\n        this.staticOutputRepaintPending = true;\n    };\n    writeToStdout(data) {",
  },
]);

// ink-text-input (optional vendor with externalCursorOffset support)
await copyToResolved(
  "vendor/ink-text-input/build/index.js",
  "ink-text-input/build/index.js",
);

console.log("[patch] Ink runtime patched");

// On Unix with a supported Bun available, use a polyglot shebang to prefer it.
// This enables Bun.secrets for secure keychain storage instead of fallback.
// Windows and installs with an older Bun keep the Node shebang.
if (process.platform !== "win32") {
  try {
    const bunVersion = execSync("bun --version", { encoding: "utf-8" }).trim();
    if (isBunVersionSupported(bunVersion)) {
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
    } else {
      console.log(
        `[patch] Bun ${bunVersion} is below ${minimumBunVersion}; keeping Node runtime`,
      );
    }
  } catch {
    // Bun not available, keep node shebang
  }
}
