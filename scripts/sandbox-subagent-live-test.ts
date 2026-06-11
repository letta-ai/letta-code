#!/usr/bin/env bun
/**
 * Live bring-up for the REAL subagent spawn entry point (step B / closing the
 * end-to-end gap). The earlier memory-mode script drove the policy builder +
 * `wrapLauncher` directly; this one goes through the production
 * `wrapSubagentLauncher` — the same function `subagents/manager.ts` calls — so
 * it exercises the actual gating (flag / permissionMode / backendMode), the
 * real memory-root resolution, and the sandbox env it returns. It then spawns
 * the wrapped child the way the manager does (`spawn` with cwd = memory dir,
 * env = childEnv + sandboxEnv) and asserts kernel isolation.
 *
 * The ONLY substitution vs a true agent is the inner launcher command: a
 * memory subagent normally runs the letta CLI (needs an LLM round-trip), so we
 * swap a `/bin/bash` filesystem probe in its place. Everything around it —
 * gating, policy, mount namespace, spawn cwd/env — is the real path.
 *
 *   HOME="$(mktemp -d)" bun scripts/sandbox-subagent-live-test.ts
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { wrapSubagentLauncher } from "@/agent/subagents/sandbox";
import { resolveAllowedMemoryRoots } from "@/permissions/memory-paths";
import { detectSandboxBackend } from "@/sandbox/availability";
import { getTranscriptRoot } from "@/utils/transcript-paths";

const home = realpathSync(homedir());
if (!home.startsWith("/private/") && !home.startsWith("/tmp")) {
  console.error(`Refusing to run: HOME=${home} is not a throwaway dir.`);
  process.exit(1);
}
const avail = detectSandboxBackend();
console.log(`backend: ${avail.backend ?? "none"} — ${avail.reason}`);
if (!avail.backend) process.exit(1);

// Memory subagents operate on the PARENT's memory; a different agent is the
// cross-agent target that must stay denied.
const PARENT = "agent-parent";
const agents = join(home, ".letta", "agents");
const parentMem = join(agents, PARENT, "memory");
const otherMem = join(agents, "agent-other", "memory");
mkdirSync(parentMem, { recursive: true });
mkdirSync(otherMem, { recursive: true });
writeFileSync(join(parentMem, "mine.md"), "SELFDATA");
writeFileSync(join(otherMem, "secret.md"), "TOPSECRET");

// Transcripts are harness metadata the memory subagent persists via its headless
// loop. They live at ~/.letta/transcripts (OUTSIDE the memory dir), so a
// memory-only writableRoots set would silently disable transcript writes under
// restrictWrites:true — the exact regression this probe guards against. Pin the
// root to the throwaway HOME so the carve and the probe agree.
delete process.env.LETTA_TRANSCRIPT_ROOT;
const transcriptRoot = getTranscriptRoot();
mkdirSync(transcriptRoot, { recursive: true });

// Resolve the parent's memory roots exactly like the manager does.
process.env.MEMORY_DIR = parentMem;
const inherited = resolveAllowedMemoryRoots({ currentAgentId: PARENT });
const baseInput = {
  launcher: { command: "/bin/bash", args: ["-c", "__PROBE__"] },
  backendMode: "api",
  memoryRoots: inherited.roots,
  inheritedPrimaryRoot: inherited.primaryRoot,
} as const;

let failures = 0;
function assert(label: string, cond: boolean): void {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
}

// --- 1. Gating: wrapSubagentLauncher must only wrap memory-mode/api/flag-on ---
console.log("\n=== gating (the real production guard) ===");
assert(
  "flag explicitly OFF (LETTA_FS_SANDBOX=0) → not wrapped (spawn unchanged)",
  wrapSubagentLauncher({
    ...baseInput,
    permissionMode: "memory",
    env: { LETTA_FS_SANDBOX: "0" },
  }) === null,
);
assert(
  "flag unset → wrapped (sandbox is on by default)",
  wrapSubagentLauncher({
    ...baseInput,
    permissionMode: "memory",
    env: {},
  }) !== null,
);
const onEnv = { LETTA_FS_SANDBOX: "1" };
assert(
  "non-memory mode → not wrapped",
  wrapSubagentLauncher({
    ...baseInput,
    permissionMode: "default",
    env: onEnv,
  }) === null,
);
assert(
  "local backend → wrapped (write-scoped against the memfs tree)",
  wrapSubagentLauncher({
    ...baseInput,
    permissionMode: "memory",
    backendMode: "local",
    env: onEnv,
  }) !== null,
);

const wrapped = wrapSubagentLauncher({
  ...baseInput,
  permissionMode: "memory",
  env: onEnv,
});
assert("memory + api + flag ON → wrapped", wrapped !== null);
assert(
  `wrapped command is the ${avail.backend} wrapper`,
  wrapped?.command !== "/bin/bash" &&
    (avail.backend === "bwrap"
      ? wrapped?.command === avail.bwrapPath
      : wrapped?.command?.endsWith("sandbox-exec") === true),
);
assert(
  "sandbox sentinel present in returned env",
  Boolean(wrapped?.sandboxEnv && Object.keys(wrapped.sandboxEnv).length > 0),
);
if (!wrapped) {
  rmSync(join(home, ".letta"), { recursive: true, force: true });
  process.exit(1);
}

// --- 2. Behavioral: spawn the wrapped child the way the manager spawns it ---
console.log("\n=== behavioral (spawn cwd=memory dir, env=child+sandbox) ===");
const childEnv = { ...process.env, ...onEnv, ...wrapped.sandboxEnv };
function probe(label: string, cmd: string, expectOk: boolean): void {
  const args = wrapped.args.map((a) => (a === "__PROBE__" ? cmd : a));
  const r = spawnSync(wrapped.command, args, {
    cwd: parentMem, // memory subagent's working dir is the memory dir
    env: childEnv,
    encoding: "utf8",
    timeout: 15000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\s+/g, " ").trim();
  const leaked = /TOPSECRET/.test(out);
  const ok = expectOk ? r.status === 0 : r.status !== 0;
  if (!(ok && !leaked)) failures++;
  console.log(
    `${ok && !leaked ? "PASS" : "FAIL"}  ${label} :: exit=${r.status} ${out.slice(0, 80)}`,
  );
}

{
  const args = wrapped.args.map((a) =>
    a === "__PROBE__" ? 'echo "envkeys=$(env | wc -l | tr -d " ")"' : a,
  );
  const r = spawnSync(wrapped.command, args, {
    cwd: parentMem,
    env: childEnv,
    encoding: "utf8",
  });
  const keys = Number(/envkeys=(\d+)/.exec(r.stdout ?? "")?.[1] ?? "0");
  assert(`env survives in wrapped child (envkeys=${keys})`, keys > 10);
}
probe("read parent memory (allow)", "cat mine.md", true);
probe("write parent memory (allow)", "echo x > note.md && echo OK", true);
probe("read other agent (DENY)", `cat ${join(otherMem, "secret.md")}`, false);
probe(
  "write other agent (DENY)",
  `echo x > ${join(otherMem, "evil.md")}`,
  false,
);
probe(
  "write outside memory (DENY)",
  `echo x > ${join(agents, PARENT, "sneak.md")}`,
  false,
);
// Regression guard: harness state under ~/.letta MUST stay writable, or the
// memory subagent silently drops its transcript / fails its startup settings
// write (setMemfsEnabled) under the sandbox.
probe(
  "write transcript root (allow)",
  `echo x > ${join(transcriptRoot, "t.txt")} && echo OK`,
  true,
);
probe(
  "write ~/.letta settings file (allow)",
  `echo x > ${join(home, ".letta", ".lettasettings")} && echo OK`,
  true,
);
// But writes still can't escape ~/.letta to the repo/temp (the scoping).
probe("write /tmp (DENY)", "echo x > /tmp/sb_api_probe.txt", false);
probe("read broad fs (allow)", "cat /etc/hosts > /dev/null && echo OK", true);

rmSync(join(home, ".letta"), { recursive: true, force: true });
console.log(
  `\n${failures === 0 ? "✓ subagent spawn path confined (gating + isolation)" : `✗ ${failures} case(s) failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
