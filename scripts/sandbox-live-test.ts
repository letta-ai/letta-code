#!/usr/bin/env bun
/**
 * Live bring-up test for the memory-mode subagent sandbox.
 *
 * Validates that a REAL process can run under the memory-mode profile against a
 * real backend — the thing the unit tests and the synthetic spike can't cover.
 *
 * Two tiers:
 *   Tier 1 (default, zero cost, no side effects): under the actual memory-mode
 *     profile, confirm bun executes, outbound TLS works, and measure the exact
 *     filesystem write-allow/deny matrix (memory ok, repo/logs/settings denied).
 *   Tier 2 (REAL_TURN=1, costs tokens + creates a cloud agent): run a real
 *     headless `letta` memory turn under the profile against Letta cloud and
 *     check it completes without sandbox denials.
 *
 * Run:  bun scripts/sandbox-live-test.ts
 *       REAL_TURN=1 bun scripts/sandbox-live-test.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildMemoryModeSandboxPolicy,
  canonicalizeRoot,
} from "@/permissions/sandbox-policy";
import { detectSandboxBackend } from "@/sandbox/availability";
import { wrapLauncher } from "@/sandbox/wrap";

const REPO_ROOT = "/Users/devanshjain/Desktop/code";
const WORKTREE_INDEX = join(
  REPO_ROOT,
  ".claude/worktrees/fs-sandbox/src/index.ts",
);

/** Parse a .env file into a map without ever printing values. */
function loadDotEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function runWrapped(
  launcher: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs = 30000,
): { code: number | null; out: string } {
  const [exe, ...args] = launcher;
  const res = spawnSync(exe as string, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return {
    code: res.status,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

function main(): void {
  const dotenv = loadDotEnv(join(REPO_ROOT, ".env"));
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Fill in only what's missing; never log values.
  for (const k of ["LETTA_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
    if (!env[k] && dotenv[k]) env[k] = dotenv[k];
  }
  console.log(
    `\n.env keys present: ${
      ["LETTA_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]
        .filter((k) => env[k])
        .join(", ") || "none"
    }`,
  );

  const avail = detectSandboxBackend();
  console.log(`Sandbox backend: ${avail.backend ?? "none"} — ${avail.reason}`);
  if (!avail.backend) {
    console.log("No backend on this host; cannot live-test. Exiting.\n");
    return;
  }

  const home = homedir();
  const memoryDir = canonicalizeRoot(
    join(home, ".letta", "agents", "sandbox-livetest", "memory"),
  );
  mkdirSync(memoryDir, { recursive: true });

  const policy = buildMemoryModeSandboxPolicy({
    memoryRoots: [memoryDir],
    env,
  });
  const wrap = (inner: string[]) =>
    wrapLauncher(inner, policy, {
      backend: avail.backend,
      bwrapPath: avail.bwrapPath,
    }) as string[];

  // ---- Tier 1: runtime viability + write matrix (no cost) ----
  console.log("\n=== Tier 1: runtime viability under the profile ===");

  const version = runWrapped(wrap(["bun", "--version"]), env, memoryDir);
  console.log(
    `bun runs under profile: ${version.code === 0 ? `yes (v${version.out.trim()})` : `NO (exit ${version.code})`}`,
  );

  const netScript =
    'try{const r=await fetch("https://api.letta.com/");console.log("NET",r.status);}catch(e){console.log("NET ERR",e.message);}';
  const net = runWrapped(wrap(["bun", "-e", netScript]), env, memoryDir);
  console.log(
    `outbound TLS under profile: ${net.out.includes("NET ERR") ? `NO — ${net.out.trim()}` : `yes (${net.out.trim()})`}`,
  );

  const targets: Array<[string, string]> = [
    ["memory-dir", join(memoryDir, "probe.txt")],
    ["tmp", "/tmp/sandbox-livetest-probe.txt"],
    ["repo", join(REPO_ROOT, "sandbox-livetest-probe.txt")],
    ["letta-logs", join(home, ".letta", "logs", "sandbox-livetest-probe.txt")],
    ["letta-settings", join(home, ".letta", "settings-livetest-probe.txt")],
    [
      "other-agent",
      join(home, ".letta", "agents", "some-other-agent", "memory", "probe.txt"),
    ],
  ];
  // The subagent's cwd is the memory dir, which lives inside ~/.letta/agents.
  // This is the exact condition that, with a read-deny on that tree, empties
  // the child env under Seatbelt — so confirm env survives here.
  const envScript = `console.log("ENV keys=" + Object.keys(process.env).length + " hasMEMORY_DIR=" + !!process.env.MEMORY_DIR);`;
  const envProbe = runWrapped(
    wrap(["bun", "-e", envScript]),
    { ...env, MEMORY_DIR: memoryDir },
    memoryDir,
  );
  console.log(`child env from memory-dir cwd: ${envProbe.out.trim()}`);

  const probeScript = `
    const fs = require("node:fs");
    const path = require("node:path");
    for (const [label, p] of JSON.parse(process.env.PROBE_TARGETS)) {
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, "x");
        console.log("WRITE " + label + " ok");
        fs.rmSync(p, { force: true });
      } catch (e) { console.log("WRITE " + label + " DENIED " + (e.code || e.message)); }
    }`;
  const probe = runWrapped(
    wrap(["bun", "-e", probeScript]),
    { ...env, PROBE_TARGETS: JSON.stringify(targets) },
    memoryDir,
  );

  console.log("\nwrite matrix (memory mode = writes only to memory + tmp):");
  const writeLines = probe.out
    .split("\n")
    .filter((l) => l.startsWith("WRITE "));
  if (writeLines.length === 0) {
    console.log(
      `  (no probe output; exit=${probe.code}) raw: ${JSON.stringify(probe.out)}`,
    );
  }
  for (const line of writeLines) console.log(`  ${line.slice(6)}`);

  // ---- Tier 2: real cloud turn (opt-in) ----
  if (env.REAL_TURN === "1") {
    runRealTurn(env, memoryDir, avail);
  } else {
    console.log(
      "\n=== Tier 2 skipped (set REAL_TURN=1 to run a real cloud memory turn) ===\n",
    );
  }

  rmSync(join(home, ".letta", "agents", "sandbox-livetest"), {
    recursive: true,
    force: true,
  });
}

function runRealTurn(
  env: NodeJS.ProcessEnv,
  memoryDir: string,
  avail: { backend: "seatbelt" | "bwrap" | null; bwrapPath?: string },
): void {
  if (!env.LETTA_API_KEY) {
    console.log("\n=== Tier 2: no LETTA_API_KEY — cannot run cloud turn ===\n");
    return;
  }
  console.log("\n=== Tier 2: real headless memory turn under the profile ===");

  const cliArgs = [
    WORKTREE_INDEX,
    "--backend",
    "api",
    "--new-agent",
    "--system",
    "memory",
    "--base-tools",
    "none",
    "--no-memfs",
    "-p",
    "Reply with exactly: LIVE_OK",
    "--output-format",
    "stream-json",
    "--permission-mode",
    "memory",
  ];
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    MEMORY_DIR: memoryDir,
    LETTA_MEMORY_DIR: memoryDir,
    LETTA_CODE_AGENT_ROLE: "subagent",
    LETTA_SANDBOX: avail.backend ?? "",
  };
  delete childEnv.LETTA_LOCAL_BACKEND_EXPERIMENTAL;

  const policy = buildMemoryModeSandboxPolicy({
    memoryRoots: [memoryDir],
    env: childEnv,
  });
  // Running the CLI from source with cwd=memoryDir: bun finds tsconfig (for @/)
  // via the entry file, but bunfig.toml (the .mdx-as-text loader) via cwd, which
  // is outside the repo. Point it at the repo's bunfig explicitly. A production
  // subagent runs a built binary with loaders compiled in, so this is harness-only.
  const bunCmd = ["bun", "-c", join(REPO_ROOT, "bunfig.toml"), ...cliArgs];
  const wrapped = wrapLauncher(bunCmd, policy, {
    backend: avail.backend,
    bwrapPath: avail.bwrapPath,
  }) as string[];

  // The bring-up question is "does the sandbox change the process's behavior?",
  // not "can this harness drive a full headless turn from source". So run the
  // identical command unwrapped vs wrapped and compare: matching exit codes with
  // no sandbox denials means the sandbox is transparent to the real CLI process.
  const bare = runWrapped(bunCmd, childEnv, memoryDir, 120000);
  const res = runWrapped(wrapped, childEnv, memoryDir, 120000);

  const denied =
    /operation not permitted|read-only file system|permission denied/i.test(
      res.out,
    );
  const transparent = bare.code === res.code && !denied;
  const idMatch =
    res.out.match(/"agent_?[iI]d"\s*:\s*"([^"]+)"/) ||
    res.out.match(/(agent-[0-9a-f-]{8,})/);

  console.log(`unwrapped: exit=${bare.code} bytes=${bare.out.length}`);
  console.log(`wrapped:   exit=${res.code} bytes=${res.out.length}`);
  console.log(`sandbox-denied writes: ${denied ? "YES" : "none"}`);
  console.log(
    `sandbox transparent (wrapped behaves like unwrapped): ${transparent ? "yes" : "NO"}`,
  );
  if (idMatch) {
    console.log(`created cloud agent id: ${idMatch[1]} (delete if unwanted)`);
  }
  if (!transparent) {
    console.log("\n--- wrapped output tail ---");
    console.log(res.out.split("\n").slice(-25).join("\n"));
  }
  console.log();
}

main();
