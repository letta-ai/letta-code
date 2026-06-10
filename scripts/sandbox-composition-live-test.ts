#!/usr/bin/env bun
/**
 * End-to-end composition test: the cross-agent guard and the kernel sandbox,
 * both live, on the real Bash pipeline.
 *
 * The real agent loop runs two layers in sequence:
 *   1. the cross-agent guard at the permission stage (before dispatch), and
 *   2. applyParentShellSandbox at spawn (inside the real bash() tool).
 * This drives both exactly that way and asserts they compose: legitimate
 * self/repo commands pass BOTH layers (proving the sandbox's self carve-out
 * matches what the guard allows — no false-positive conflict), while every
 * cross-agent attack is stopped by at least one layer. The headline case is the
 * symlink inside a Bash command: the guard's shell scan is lexical (the 3b
 * realpath pass only covers in-process file tools), so it slips the guard — and
 * the kernel denies it. That is the whole point of running both.
 *
 * Run with a throwaway HOME so the agents tree it walls off is one we own:
 *
 *   HOME="$(mktemp -d)" bun scripts/sandbox-composition-live-test.ts
 */
import {
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { evaluateCrossAgentGuard } from "@/permissions/cross-agent-guard";
import { runWithRuntimeContext } from "@/runtime-context";
import { detectSandboxBackend } from "@/sandbox/availability";
import { bash } from "@/tools/impl/bash";

const home = realpathSync(homedir());
if (!home.startsWith("/private/") && !home.startsWith("/tmp")) {
  console.error(
    `Refusing to run: HOME=${home} is not a throwaway dir. Launch with HOME="$(mktemp -d)".`,
  );
  process.exit(1);
}

const avail = detectSandboxBackend();
console.log(`backend: ${avail.backend ?? "none"} — ${avail.reason}`);
if (!avail.backend) {
  console.error("No sandbox backend on this host; cannot test composition.");
  process.exit(1);
}

const SELF = "agent-self";
const OTHER = "agent-other";
const agents = join(home, ".letta", "agents");
const selfMem = join(agents, SELF, "memory");
const otherMem = join(agents, OTHER, "memory");
mkdirSync(selfMem, { recursive: true });
mkdirSync(otherMem, { recursive: true });
writeFileSync(join(otherMem, "secret.md"), "TOPSECRET");

// A benign-looking symlink OUTSIDE the agents tree pointing into other's memory.
const link = "/tmp/sb-comp-link";
rmSync(link, { force: true });
symlinkSync(otherMem, link);

// The parent agent's cwd is the repo — outside the agents tree.
const repoCwd = process.cwd();

// Make the guard and the bash tool agree on "self": both resolve the agent id
// and memory dir from the env / runtime context.
process.env.LETTA_FS_SANDBOX = "1";
process.env.AGENT_ID = SELF;
process.env.MEMORY_DIR = selfMem;

// SB_NO_GUARD=1 disables the static guard so only the kernel sandbox is live —
// the "can the kernel stand alone?" question (the precondition for deleting the
// guard in step 4). With the guard off, EVERY attack must be stopped by the
// kernel, not merely "by at least one layer".
const guardEnabled = process.env.SB_NO_GUARD !== "1";

type Layer = "guard" | "kernel" | "none";
interface Outcome {
  blockedBy: Layer;
  status: string;
  text: string;
}

async function runCommand(command: string): Promise<Outcome> {
  // Layer 1 — the cross-agent guard (permission stage, before dispatch).
  const verdict = evaluateCrossAgentGuard("Bash", { command }, repoCwd, {
    env: process.env,
    currentAgentId: SELF,
    disableMemoryGuard: !guardEnabled,
  });
  if (verdict) {
    return {
      blockedBy: "guard",
      status: "denied",
      text: verdict.offendingAgentIds.join(","),
    };
  }

  // Layer 2 — the real bash() tool (wraps via applyParentShellSandbox at spawn).
  const result = await runWithRuntimeContext(
    { workingDirectory: repoCwd, agentId: SELF },
    () => bash({ command }),
  );
  const text = result.content
    .map((c) => c.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const denied = /operation not permitted|read-only file system/i.test(text);
  return {
    blockedBy: result.status === "error" && denied ? "kernel" : "none",
    status: result.status,
    text,
  };
}

interface Case {
  label: string;
  command: string;
  expect: (o: Outcome, guard: boolean) => boolean;
  why: string;
}

// An attack must be stopped by *at least one* layer when the guard is on, but
// by the kernel specifically when the guard is off (nothing else is left).
function attackBlocked(o: Outcome, guard: boolean): boolean {
  return guard ? o.blockedBy !== "none" : o.blockedBy === "kernel";
}

const cases: Case[] = [
  {
    label: "legit: write+read self memory",
    command: `echo hi > ${join(selfMem, "note.md")} && cat ${join(selfMem, "note.md")}`,
    expect: (o) => o.blockedBy === "none" && /hi/.test(o.text),
    why: "self memory must pass every active layer (carve-out matches guard)",
  },
  {
    label: "legit: write repo/tmp",
    command: "echo x > /tmp/sb-comp-ok.txt && echo OK",
    expect: (o) => o.blockedBy === "none" && /OK/.test(o.text),
    why: "non-agent writes stay allowed",
  },
  {
    label: "attack: direct read of other's memory",
    command: `cat ${join(otherMem, "secret.md")}`,
    expect: (o, g) => attackBlocked(o, g) && !/TOPSECRET/.test(o.text),
    why: "guard catches the literal path; kernel denies it too when guard is off",
  },
  {
    label: "attack: symlink read of other's memory",
    command: `cat ${link}/secret.md`,
    expect: (o) => o.blockedBy === "kernel" && !/TOPSECRET/.test(o.text),
    why: "lexical guard always misses the symlink; the KERNEL denies it",
  },
  {
    label: "attack: enumerate the agents tree",
    command: `ls ${agents} && echo LISTED`,
    expect: (o, g) =>
      attackBlocked(o, g) && !/LISTED .*agent-other/.test(o.text),
    why: "bare agents-root reference is denied",
  },
];

let failures = 0;
const mode = guardEnabled
  ? "guard + kernel (both layers live)"
  : "kernel only (guard disabled — can it stand alone?)";
console.log(`\n=== ${mode} ===`);
for (const c of cases) {
  const outcome = await runCommand(c.command);
  const pass = c.expect(outcome, guardEnabled);
  if (!pass) failures++;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${c.label}\n` +
      `        blocked-by=${outcome.blockedBy} status=${outcome.status}` +
      ` :: ${outcome.text.slice(0, 100)}\n` +
      `        (${c.why})`,
  );
}

rmSync(join(home, ".letta"), { recursive: true, force: true });
rmSync(link, { force: true });
rmSync("/tmp/sb-comp-ok.txt", { force: true });

console.log(
  `\n${failures === 0 ? "✓ composition holds" : `✗ ${failures} case(s) failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
