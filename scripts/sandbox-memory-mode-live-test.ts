#!/usr/bin/env bun
/**
 * Live bring-up for the read-isolating memory-mode subagent sandbox (step B2).
 *
 * The memory subagent's cwd is its memory dir INSIDE ~/.letta/agents, which is
 * the exact condition that empties the child env under Seatbelt if a cwd
 * ancestor is read-denied. This drives the real buildMemoryModeSandboxPolicy +
 * wrapLauncher and spawns from that cwd to prove, in one shot, that:
 *   - the env survives (the agent-dir readonly carve keeps cwd traversable),
 *   - another agent's memory is read- AND write-denied (cross-agent isolation),
 *   - the subagent can read+write its own memory, and
 *   - writes are still scoped to the memory dir (restrictWrites).
 *
 *   HOME="$(mktemp -d)" bun scripts/sandbox-memory-mode-live-test.ts
 */
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildMemoryModeSandboxPolicy } from "@/permissions/sandbox-policy";
import { detectSandboxBackend } from "@/sandbox/availability";
import { wrapLauncher } from "@/sandbox/wrap";

const home = realpathSync(homedir());
if (!home.startsWith("/private/") && !home.startsWith("/tmp")) {
  console.error(`Refusing to run: HOME=${home} is not a throwaway dir.`);
  process.exit(1);
}
const avail = detectSandboxBackend();
console.log(`backend: ${avail.backend ?? "none"} — ${avail.reason}`);
if (!avail.backend) process.exit(1);

const agents = join(home, ".letta", "agents");
const selfMem = join(agents, "agent-self", "memory");
const otherMem = join(agents, "agent-other", "memory");
mkdirSync(selfMem, { recursive: true });
mkdirSync(otherMem, { recursive: true });
writeFileSync(join(selfMem, "mine.md"), "SELFDATA");
writeFileSync(join(otherMem, "secret.md"), "TOPSECRET");

const policy = buildMemoryModeSandboxPolicy({
  memoryRoots: [selfMem],
  env: {},
});
const wrapped = wrapLauncher(["/bin/zsh", "-c", "__PROBE__"], policy, {
  backend: avail.backend,
  bwrapPath: avail.bwrapPath,
});
if (!wrapped) {
  console.error("wrapLauncher returned null");
  process.exit(1);
}

let failures = 0;
function probe(label: string, cmd: string, expectOk: boolean): void {
  const launcher = wrapped.map((a) => (a === "__PROBE__" ? cmd : a));
  // Spawn from the memory dir (inside the denied tree) — the empty-env risk.
  const { spawnSync } = require("node:child_process");
  const r = spawnSync(launcher[0], launcher.slice(1), {
    cwd: selfMem,
    encoding: "utf8",
    timeout: 15000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\s+/g, " ").trim();
  const ok = expectOk ? r.status === 0 : r.status !== 0;
  const leaked = /TOPSECRET/.test(out);
  const pass = ok && !leaked;
  if (!pass) failures++;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${label} :: exit=${r.status} ${out.slice(0, 90)}`,
  );
}

console.log("\n=== memory-mode subagent (cwd = memory dir, real policy) ===");
// env survival is the linchpin; assert a healthy key count explicitly.
{
  const { spawnSync } = require("node:child_process");
  const launcher = wrapped.map((a) =>
    a === "__PROBE__" ? 'echo "envkeys=$(env | wc -l | tr -d " ")"' : a,
  );
  const r = spawnSync(launcher[0], launcher.slice(1), {
    cwd: selfMem,
    encoding: "utf8",
    timeout: 15000,
  });
  const keys = Number(/envkeys=(\d+)/.exec(r.stdout ?? "")?.[1] ?? "0");
  const pass = keys > 10;
  if (!pass) failures++;
  console.log(
    `${pass ? "PASS" : "FAIL"}  env survives cwd=memory-dir :: envkeys=${keys}`,
  );
}
probe("read self memory (allow)", "cat mine.md", true);
probe("read other memory (DENY)", `cat ${join(otherMem, "secret.md")}`, false);
probe("write self memory (allow)", "echo x > note.md && echo OK", true);
probe(
  "write other memory (DENY)",
  `echo x > ${join(otherMem, "evil.md")}`,
  false,
);
probe(
  "write own agent dir non-memory (DENY)",
  `echo x > ${join(agents, "agent-self", "sneak.md")}`,
  false,
);
probe(
  "read outside file (allow)",
  "cat /etc/hosts > /dev/null && echo OK",
  true,
);

rmSync(join(home, ".letta"), { recursive: true, force: true });
console.log(
  `\n${failures === 0 ? "✓ memory-mode read isolation holds (env intact)" : `✗ ${failures} case(s) failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
