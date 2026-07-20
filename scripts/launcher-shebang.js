import { readFileSync, writeFileSync } from "node:fs";

export const NODE_LAUNCHER = "#!/usr/bin/env node";
export const BUN_REEXEC_ENV = "LETTA_CODE_BUN_REEXECED";
export const SKIP_BUN_REEXEC_ENV = "LETTA_CODE_SKIP_BUN_REEXEC";

export const BUN_REEXEC_PRELUDE = String.raw`const __lettaCodeMaybeReexecBun = async () => {
  if (typeof process === "undefined") return;
  if (typeof globalThis.Bun !== "undefined") return;
  if (process.platform === "win32") return;
  if (process.env.LETTA_CODE_BUN_REEXECED === "1") return;
  if (process.env.LETTA_CODE_SKIP_BUN_REEXEC === "1") return;

  const scriptPath = process.argv[1];
  if (!scriptPath) return;

  const [
    { spawnSync },
    { accessSync, constants, realpathSync },
    { delimiter, join },
    { fileURLToPath },
  ] =
    await Promise.all([
      import("node:child_process"),
      import("node:fs"),
      import("node:path"),
      import("node:url"),
    ]);

  const realpathOrSelf = (value) => {
    try {
      return realpathSync(value);
    } catch {
      return value;
    }
  };

  if (realpathOrSelf(scriptPath) !== realpathOrSelf(fileURLToPath(import.meta.url))) {
    return;
  }

  if (typeof process.execve !== "function") return;

  const bunPath = (process.env.PATH ?? "")
    .split(delimiter)
    .map((directory) => join(directory || ".", "bun"))
    .find((candidate) => {
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  if (!bunPath) return;

  // Node 22 aborts on a native execve failure instead of throwing. Probe the
  // discovered binary first so corrupt or wrong-architecture Bun installs
  // preserve the Node fallback rather than crashing the CLI.
  const probe = spawnSync(bunPath, ["--version"], {
    stdio: "ignore",
    timeout: 2000,
  });
  if (probe.error || probe.status !== 0) return;

  // Replace this bootstrap instead of supervising a child process so
  // long-running CLI/listener commands keep normal signal and process-tree
  // semantics. The package requires Node >=22.19, which provides execve on
  // supported Unix platforms.
  process.execve(
    bunPath,
    [bunPath, scriptPath, ...process.argv.slice(2)],
    { ...process.env, LETTA_CODE_BUN_REEXECED: "1" },
  );
};
await __lettaCodeMaybeReexecBun();`;

const LEGACY_BUN_PREFERRED_UNIX_LAUNCHER = [
  "#!/bin/sh",
  `":" //#; exec /usr/bin/env sh -c 'command -v bun >/dev/null && exec bun "$0" "$@" || exec node "$0" "$@"' "$0" "$@"`,
].join("\n");

const NODE_BOOTSTRAP_LAUNCHER = `${NODE_LAUNCHER}\n${BUN_REEXEC_PRELUDE}`;

const KNOWN_LAUNCHERS = [
  NODE_BOOTSTRAP_LAUNCHER,
  LEGACY_BUN_PREFERRED_UNIX_LAUNCHER,
  NODE_LAUNCHER,
];

function splitFirstLines(content, count) {
  const lines = [];
  let offset = 0;

  for (let i = 0; i < count; i += 1) {
    const newlineIndex = content.indexOf("\n", offset);
    if (newlineIndex === -1) {
      if (i !== count - 1) {
        return null;
      }
      lines.push(content.slice(offset).replace(/\r$/u, ""));
      return { lines, rest: "" };
    }

    lines.push(content.slice(offset, newlineIndex).replace(/\r$/u, ""));
    offset = newlineIndex + 1;
  }

  return { lines, rest: content.slice(offset) };
}

function stripLauncherLines(content, launcher) {
  const launcherLines = launcher.split("\n");
  const parsed = splitFirstLines(content, launcherLines.length);
  if (!parsed) {
    return null;
  }

  for (let i = 0; i < launcherLines.length; i += 1) {
    if (parsed.lines[i] !== launcherLines[i]) {
      return null;
    }
  }

  return parsed.rest;
}

function stripGenericShebang(content) {
  const parsed = splitFirstLines(content, 1);
  if (!parsed || !parsed.lines[0]?.startsWith("#!")) {
    return content;
  }
  return parsed.rest;
}

export function stripLauncher(content) {
  for (const launcher of KNOWN_LAUNCHERS) {
    const stripped = stripLauncherLines(content, launcher);
    if (stripped !== null) {
      return stripped;
    }
  }

  return stripGenericShebang(content);
}

export function normalizeLauncherContent(content) {
  return `${NODE_BOOTSTRAP_LAUNCHER}\n${stripLauncher(content)}`;
}

export function normalizeLauncherFile(filePath) {
  const original = readFileSync(filePath, "utf-8");
  const normalized = normalizeLauncherContent(original);
  const changed = normalized !== original;

  if (changed) {
    writeFileSync(filePath, normalized);
  }

  return { changed, launcher: NODE_LAUNCHER };
}
