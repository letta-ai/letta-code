#!/usr/bin/env bun
/**
 * Cloud (API backend) mirror of the L5 reflection test — focused on transcript
 * writing. The write-scope-parity change carves the transcript root writable on
 * BOTH backends; on cloud the subagent policy is `writableRoots=[memory, transcriptRoot]`
 * under restrictWrites:true, so a memory-only set would silently drop the
 * subagent's transcript. This drives a REAL cloud bidirectional session with a
 * real reflection subagent and asserts the subagent runs sandboxed, doesn't trap,
 * and transcripts are written.
 *
 * Spends tokens AND creates a real cloud agent in the account. Requires
 * LETTA_API_KEY + a throwaway HOME:
 *   set -a; source /path/.env; set +a
 *   HOME="$(mktemp -d)" bun scripts/sandbox-l5-cloud-reflection.ts
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = realpathSync(homedir());
if (!home.startsWith("/private/") && !home.startsWith("/tmp")) {
  console.error(`Refusing to run: HOME=${home} is not a throwaway dir.`);
  process.exit(1);
}
if (!process.env.LETTA_API_KEY) {
  console.error("Need LETTA_API_KEY for the cloud backend.");
  process.exit(1);
}

const transcriptsDir = join(home, ".letta", "transcripts");

const env = {
  ...process.env,
  LETTA_FS_SANDBOX: "1",
  LETTA_DEBUG: "1",
};

const proc = spawn(
  "bun",
  [
    "run",
    "dev",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--reflection-trigger",
    "step-count",
    "--reflection-step-count",
    "1",
    "--yolo",
    "--new-agent",
    "--memfs",
    "--base-tools",
    "memory",
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
  proc.stdin.write(
    `${JSON.stringify({ type: "user", message: { content } })}\n`,
  );
const resultCount = () => (out.match(/"type":\s*"result"/g) || []).length;
// Count transcript FILES anywhere under the root. The carve makes the whole
// root writable, so the reflection transcript flow (payload/state/transcript)
// lands here. On cloud the reflection transcript is keyed to the PARENT agent
// (the subagent doesn't spawn a separate transcript dir), so count files, not
// dirs — and any blocked write would be visible as EPERM (checked separately).
function transcriptFileCount(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    n += statSync(p).isDirectory() ? transcriptFileCount(p) : 1;
  }
  return n;
}

async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.error(`  [timeout] ${label}`);
  return false;
}

const M1 =
  "Automated CI test, no human present, do not ask questions. Use the memory tool to create or update reference/ci/a.md with body text A_OK. Then reply with exactly DONE_ONE.";
const M2 =
  "Automated CI test, no human present, do not ask questions. Use the memory tool to create or update reference/ci/b.md with body text B_OK. Then reply with exactly DONE_TWO.";

console.log("→ turn 1");
send(M1);
await waitFor(() => resultCount() >= 1, 180000, "turn 1 result");

console.log("→ turn 2 (crosses reflection threshold)");
send(M2);
await waitFor(() => resultCount() >= 2, 180000, "turn 2 result");

console.log("→ waiting for background reflection subagent to spawn…");
await waitFor(
  () =>
    /memory-mode child sandboxed via/.test(err) ||
    /Reflect on recent conversations/.test(both()),
  90000,
  "reflection spawn",
);
console.log("→ waiting for the reflection transcript flow to persist…");
await waitFor(
  () => transcriptFileCount(transcriptsDir) >= 1,
  150000,
  "transcript files",
);
await new Promise((r) => setTimeout(r, 10000));
proc.stdin.end();
await new Promise<void>((r) => proc.on("close", () => r()));

// ---- analysis ----
// Cross-platform trap detection: Seatbelt denies with "operation not permitted"
// / EPERM; bwrap's write-scope (--ro-bind /) denies with "Read-only file system"
// / EROFS. (Deliberately NOT matching ENOENT/"No such file or directory" — it
// appears benignly in normal output and would false-positive.) NOTE: the cloud
// transcript files are parent-written (unsandboxed), so this regex over the
// child's stderr is the primary trap signal here — keep it backend-complete.
const trap =
  /operation not permitted|Operation not permitted|EPERM|not permitted|Read-only file system|EROFS/.exec(
    both(),
  );
const wrapped = /memory-mode child sandboxed via (\w+)/.exec(err);
const reflLaunched =
  /Reflect on recent conversations/.test(both()) || Boolean(wrapped);
const tfiles = transcriptFileCount(transcriptsDir);

let failures = 0;
const check = (label: string, ok: boolean, extra = "") => {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` :: ${extra}` : ""}`,
  );
};

console.log("\n=== cloud reflection / transcript results ===");
check("reflection subagent launched", reflLaunched);
check(
  "reflection child was sandboxed",
  Boolean(wrapped),
  wrapped ? `via ${wrapped[1]}` : "no 'sandboxed via' marker",
);
check(
  "NO sandbox trap (no EPERM/EROFS / not-permitted)",
  !trap,
  trap ? `LEAK: ${trap[0]}` : "clean",
);
check(
  "reflection transcript flow persisted (carve not disabling writes)",
  tfiles >= 1,
  `${tfiles} transcript file(s)`,
);

console.log(
  `\n${failures === 0 ? "✓ cloud: reflection subagent sandboxed, transcript writing NOT disabled" : `✗ cloud: ${failures} check(s) failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
