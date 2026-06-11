#!/usr/bin/env bun
/**
 * L5 — real local-backend turn with a REAL reflection subagent, under the
 * filesystem sandbox. This is the validation the synthetic live test can't give:
 * it proves a real memory-mode subagent, launched in-process by a local agent
 * with LETTA_FS_SANDBOX=1, does NOT trap under restrictWrites:true — i.e. the
 * harness write-set carved in `wrapSubagentLauncher` is actually complete.
 *
 * Drives a bidirectional (stream-json) local session with reflection forced to
 * fire after the first turn (`--reflection-step-count 1`). Reflection triggers
 * when the SECOND user message is dequeued, runs as a background subagent (its
 * own Anthropic call + on-disk persistence), and is wrapped by the production
 * `wrapSubagentLauncher`. Then asserts:
 *   - the reflection child was actually sandboxed (`memory-mode child sandboxed via`),
 *   - nothing trapped (no "operation not permitted" / EPERM anywhere),
 *   - the parent's memory edits committed to memfs, and
 *   - the reflection child persisted its own agent-state (a 2nd agents/ record).
 *
 * Spends tokens. Requires ANTHROPIC_API_KEY + a throwaway HOME:
 *   set -a; source /path/.env; set +a; unset OPENAI_API_KEY
 *   HOME="$(mktemp -d)" LETTA_LOCAL_BACKEND_EXPERIMENTAL=true \
 *     bun scripts/sandbox-l5-local-reflection.ts
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = realpathSync(homedir());
if (!home.startsWith("/private/") && !home.startsWith("/tmp")) {
  console.error(`Refusing to run: HOME=${home} is not a throwaway dir.`);
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Need ANTHROPIC_API_KEY (and unset OPENAI_API_KEY to pin Anthropic).");
  process.exit(1);
}

const storage = join(home, ".letta", "lc-local-backend");
const agentsDir = join(storage, "agents");

const env = {
  ...process.env,
  LETTA_FS_SANDBOX: "1",
  LETTA_LOCAL_BACKEND_EXPERIMENTAL: "true",
  LETTA_DEBUG: "1",
};

const proc = spawn(
  "bun",
  [
    "run", "dev",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--reflection-trigger", "step-count",
    "--reflection-step-count", "1",
    "--yolo", "--new-agent", "--base-tools", "none",
  ],
  { env, stdio: ["pipe", "pipe", "pipe"] },
);

let out = "";
let err = "";
proc.stdout.on("data", (d) => {
  out += d.toString();
});
proc.stderr.on("data", (d) => {
  err += d.toString();
});

const both = () => out + err;
const send = (content: string) =>
  proc.stdin.write(`${JSON.stringify({ type: "user", message: { content } })}\n`);
const resultCount = () => (out.match(/"type":\s*"result"/g) || []).length;
const agentRecords = () =>
  existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith(".json")) : [];

async function waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.error(`  [timeout] ${label}`);
  return false;
}

const M1 = "Automated CI test, no human present, do not ask questions. Use whichever memory tool is available to create or update reference/ci/a.md with body text A_MEMFS_OK. Then reply with exactly DONE_ONE.";
const M2 = "Automated CI test, no human present, do not ask questions. Use whichever memory tool is available to create or update reference/ci/b.md with body text B_MEMFS_OK. Then reply with exactly DONE_TWO.";

console.log("→ turn 1");
send(M1);
await waitFor(() => resultCount() >= 1, 150000, "turn 1 result");

console.log("→ turn 2 (crosses reflection threshold)");
send(M2);
await waitFor(() => resultCount() >= 2, 150000, "turn 2 result");

console.log("→ waiting for background reflection subagent to spawn…");
await waitFor(
  () => /memory-mode child sandboxed via/.test(err) || /Reflect on recent conversations/.test(both()),
  90000,
  "reflection spawn",
);
console.log("→ waiting for reflection to persist (2nd agent record)…");
await waitFor(() => agentRecords().length >= 2, 150000, "reflection persisted");
// settle, then close stdin so the parent exits cleanly
await new Promise((r) => setTimeout(r, 10000));
proc.stdin.end();
await new Promise<void>((r) => proc.on("close", () => r()));

// ---- analysis ----
const trap = /operation not permitted|Operation not permitted|EPERM|not permitted/.exec(both());
const wrapped = /memory-mode child sandboxed via (\w+)/.exec(err);
const reflLaunched = /Reflect on recent conversations/.test(both()) || Boolean(wrapped);
const records = agentRecords();
const reflPersisted = records.length >= 2;
// The harness writes ~/.letta/.lettasettings on the headless startup path
// (setMemfsEnabled). A write-scope that excluded ~/.letta swallowed that as a
// "Failed to persist settings" + settings_persist_failed boundary error. With
// ~/.letta as the write base, it must NOT appear.
const settingsFail = /Failed to persist settings|settings_persist_failed/.test(both());

let failures = 0;
const check = (label: string, ok: boolean, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` :: ${extra}` : ""}`);
};

console.log("\n=== L5 results ===");
check("reflection subagent launched", reflLaunched);
check("reflection child was sandboxed", Boolean(wrapped), wrapped ? `via ${wrapped[1]}` : "no 'sandboxed via' marker in stderr");
check("NO sandbox trap (no EPERM / not-permitted)", !trap, trap ? `LEAK: ${trap[0]}` : "clean");
check("reflection child persisted its own agent-state", reflPersisted, `${records.length} agent record(s)`);
check("NO swallowed harness-write failure (settings persisted)", !settingsFail, settingsFail ? "saw settings-persist failure" : "clean");

console.log(`\n${failures === 0 ? "✓ L5: real reflection subagent runs sandboxed without trapping" : `✗ L5: ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
