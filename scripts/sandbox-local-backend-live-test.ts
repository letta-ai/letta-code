#!/usr/bin/env bun
/**
 * Live bring-up for cross-agent read-deny on the LOCAL backend (both surfaces).
 *
 * Local-backend memory lives under `~/.letta/lc-local-backend/memfs/<id>/memory`,
 * NOT `~/.letta/agents`, so the old policies (keyed to the latter) were a no-op
 * on local. This drives the REAL production entry points with the local tree:
 *   - subagents: `wrapSubagentLauncher({ backendMode: "local", ... })`
 *   - parent shells: `applyParentShellSandbox` with a local-backend env
 * and proves, on the live kernel, that:
 *   - another agent's memory is read- AND write-denied (the cross-agent goal),
 *   - the agent can read+write its OWN memory, the env survives a cwd inside the
 *     denied memfs tree, and
 *   - the subagent child can still persist its conversation / agent-state /
 *     providers OUTSIDE memfs (restrictWrites:false → no write-trap). This is the
 *     property that makes local different from the API write-scoped policy.
 *
 *   HOME="$(mktemp -d)" LETTA_LOCAL_BACKEND_EXPERIMENTAL=1 \
 *     bun scripts/sandbox-local-backend-live-test.ts
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { wrapSubagentLauncher } from "@/agent/subagents/sandbox";
import {
  getLocalBackendCrossAgentTreeRoot,
  getLocalBackendStorageDir,
} from "@/backend/local/paths";
import { detectSandboxBackend } from "@/sandbox/availability";
import { applyParentShellSandbox } from "@/tools/impl/shell-sandbox";
import { getTranscriptRoot } from "@/utils/transcript-paths";

const home = realpathSync(homedir());
if (!home.startsWith("/private/") && !home.startsWith("/tmp")) {
  console.error(`Refusing to run: HOME=${home} is not a throwaway dir.`);
  process.exit(1);
}
const avail = detectSandboxBackend();
console.log(`backend: ${avail.backend ?? "none"} — ${avail.reason}`);
if (!avail.backend) process.exit(1);

// Fake local-backend storage layout. memfs holds per-agent memory (the tree to
// wall off); conversations/agents/providers are SIBLINGS of memfs (outside the
// tree) — the harness artifacts the child must still be able to persist.
const storage = getLocalBackendStorageDir(home);
const memfs = getLocalBackendCrossAgentTreeRoot(storage);
const SELF = "agent-self";
const selfMem = join(memfs, SELF, "memory");
const otherMem = join(memfs, "agent-other", "memory");
const convDir = join(storage, "conversations");
const stateDir = join(storage, "agents");
const providersDir = join(storage, "providers");
// Reflection transcripts are harness metadata the child writes via its headless
// loop — carved writable on both backends even under write-scoping.
const transcriptRoot = getTranscriptRoot();
const repoCwd = process.cwd();
for (const d of [selfMem, otherMem, convDir, stateDir, providersDir, transcriptRoot]) {
  mkdirSync(d, { recursive: true });
}
writeFileSync(join(selfMem, "mine.md"), "SELFDATA");
writeFileSync(join(otherMem, "secret.md"), "TOPSECRET");
writeFileSync(join(providersDir, "auth.json"), "PROVIDERCREDS");

const SHELL = process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
const otherSecret = join(otherMem, "secret.md");

let failures = 0;
// A probe passes when: it never leaked another agent's secret, AND the exit
// status matches the expectation (0 = allowed, non-0 = denied).
function runProbe(
  label: string,
  launcher: string[],
  childEnv: NodeJS.ProcessEnv,
  cwd: string,
  cmd: string,
  expectOk: boolean,
): void {
  const args = launcher.slice(1).map((a) => (a === "__PROBE__" ? cmd : a));
  const r = spawnSync(launcher[0] as string, args, {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: 15000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\s+/g, " ").trim();
  const leaked = /TOPSECRET/.test(out);
  const ok = expectOk ? r.status === 0 : r.status !== 0;
  const pass = ok && !leaked;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label} :: exit=${r.status} ${out.slice(0, 80)}`);
}

// === Surface 1: memory-mode subagent (real wrapSubagentLauncher, local) ===
console.log("\n=== local subagent (wrapSubagentLauncher backendMode=local) ===");
const wrapped = wrapSubagentLauncher({
  launcher: { command: SHELL, args: ["-c", "__PROBE__"] },
  permissionMode: "memory",
  backendMode: "local",
  memoryRoots: [selfMem],
  inheritedPrimaryRoot: selfMem,
  localBackendStorageDir: storage,
  env: { LETTA_FS_SANDBOX: "1" },
  availability: avail,
});
if (!wrapped) {
  console.error("FAIL  wrapSubagentLauncher returned null for local backend");
  rmSync(join(home, ".letta"), { recursive: true, force: true });
  process.exit(1);
}
const subLauncher = [wrapped.command, ...wrapped.args];
const subEnv = { ...process.env, LETTA_FS_SANDBOX: "1", ...wrapped.sandboxEnv };
{
  // env survival is the linchpin (cwd is inside the denied memfs tree).
  const args = wrapped.args.map((a) =>
    a === "__PROBE__" ? 'echo "envkeys=$(env | wc -l | tr -d " ")"' : a,
  );
  const r = spawnSync(wrapped.command, args, { cwd: selfMem, env: subEnv, encoding: "utf8" });
  const keys = Number(/envkeys=(\d+)/.exec(r.stdout ?? "")?.[1] ?? "0");
  if (!(keys > 10)) failures++;
  console.log(`${keys > 10 ? "PASS" : "FAIL"}  env survives cwd=memfs/<self>/memory :: envkeys=${keys}`);
}
const sub = (label: string, cmd: string, expectOk: boolean) =>
  runProbe(label, subLauncher, subEnv, selfMem, cmd, expectOk);
sub("read self memory (allow)", "cat mine.md", true);
sub("read other agent memory (DENY)", `cat ${otherSecret}`, false);
sub("write self memory (allow)", "echo x > note.md && echo OK", true);
sub("write other agent memory (DENY)", `echo x > ${join(otherMem, "evil.md")}`, false);
// Write-scoping (restrictWrites:true): the agent's non-deterministic work can't
// escape memory — not to the repo, not to temp.
sub("write repo file (DENY)", `echo x > ${join(repoCwd, ".sb-sub-probe")}`, false);
sub("write /tmp (DENY)", "echo x > /tmp/sb_sub_probe.txt", false);
// No-write-trap: the harness paths the child legitimately persists ARE carved.
sub("write conversation dir (allow)", `echo x > ${join(convDir, "c.json")} && echo OK`, true);
sub("write agent-state dir (allow)", `echo x > ${join(stateDir, "a.json")} && echo OK`, true);
sub("write providers dir (allow)", `echo x > ${join(providersDir, "p.json")} && echo OK`, true);
sub("write transcript root (allow)", `echo x > ${join(transcriptRoot, "t.txt")} && echo OK`, true);
sub("read providers/auth.json (allow)", `cat ${join(providersDir, "auth.json")} > /dev/null && echo OK`, true);

// === Surface 2: parent shell (real applyParentShellSandbox, local) ===
console.log("\n=== local parent shell (applyParentShellSandbox) ===");
const parentEnv: NodeJS.ProcessEnv = {
  LETTA_FS_SANDBOX: "1",
  LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1",
  AGENT_ID: SELF,
  MEMORY_DIR: selfMem,
};
const ps = applyParentShellSandbox([SHELL, "-c", "__PROBE__"], repoCwd, parentEnv, avail);
if (ps.backend === null) {
  console.error("FAIL  applyParentShellSandbox left the launcher unwrapped on local");
  failures++;
} else {
  const par = (label: string, cmd: string, expectOk: boolean) =>
    runProbe(label, ps.launcher, { ...process.env, ...ps.env }, repoCwd, cmd, expectOk);
  par("read self memory (allow)", `cat ${join(selfMem, "mine.md")}`, true);
  par("read other agent memory (DENY)", `cat ${otherSecret}`, false);
  par("write repo file (allow)", `echo x > ${join(repoCwd, ".sb-parent-probe")} && echo OK`, true);
  par("write other agent memory (DENY)", `echo x > ${join(otherMem, "evil2.md")}`, false);
  rmSync(join(repoCwd, ".sb-parent-probe"), { force: true });
}

rmSync(join(home, ".letta"), { recursive: true, force: true });
console.log(
  `\n${failures === 0 ? "✓ local-backend cross-agent read-deny holds on both surfaces" : `✗ ${failures} case(s) failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
