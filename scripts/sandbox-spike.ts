#!/usr/bin/env bun
/**
 * Bypass spike for the filesystem sandbox (step 1 validation).
 *
 * Builds a cross-agent policy over a throwaway `.letta/agents` tree with a
 * "self" agent and an "other" agent, then runs the exact bypass classes that
 * defeat the static cross-agent guard today — symlink escape, command
 * substitution, globbing, shell nesting, a Python subprocess — both UNSANDBOXED
 * (to prove each is a real leak) and SANDBOXED (to prove the kernel blocks it).
 *
 * Run:  bun scripts/sandbox-spike.ts
 *
 * Exit 0 only if every attack is blocked under the sandbox AND the legitimate
 * self-write still succeeds. On a host with no backend it prints why and exits 0
 * (nothing to validate here).
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectSandboxBackend } from "@/sandbox/availability";
import { buildFsSandboxPolicy } from "@/sandbox/policy";
import { wrapLauncher } from "@/sandbox/wrap";

const SECRET = "CROSS_AGENT_SECRET_42";

type Kind = "read" | "writeOther" | "writeSelf";

interface Attempt {
  id: string;
  desc: string;
  kind: Kind;
  /** Marker file (writeOther/writeSelf) this attempt targets. */
  marker?: string;
  command: (p: Paths) => string;
}

interface Paths {
  agentsRoot: string;
  selfMem: string;
  otherMem: string;
  otherSecret: string;
  link: string;
  work: string;
}

function buildAttempts(): Attempt[] {
  return [
    {
      id: "direct-read",
      desc: "cat other agent's secret directly",
      kind: "read",
      command: (p) => `cat ${p.otherSecret}`,
    },
    {
      id: "symlink-escape",
      desc: "read other via a symlink planted in self",
      kind: "read",
      command: (p) =>
        `ln -sf ${p.otherMem} ${p.link} && cat ${p.link}/secret.txt`,
    },
    {
      id: "command-substitution",
      desc: "read other via $(...) command substitution",
      kind: "read",
      command: (p) => `cat $(echo ${p.otherSecret})`,
    },
    {
      id: "glob-enumeration",
      desc: "glob across the agents tree to slurp every secret",
      kind: "read",
      command: (p) => `cat ${p.agentsRoot}/*/memory/secret.txt 2>/dev/null`,
    },
    {
      id: "shell-nesting",
      desc: "read other from a nested bash -c",
      kind: "read",
      command: (p) => `bash -c "cat ${p.otherSecret}"`,
    },
    {
      id: "python-subprocess",
      desc: "read other from a python3 subprocess",
      kind: "read",
      command: (p) =>
        `python3 -c "print(open('${p.otherSecret}').read())" 2>/dev/null`,
    },
    {
      id: "write-other",
      desc: "write into other agent's memory",
      kind: "writeOther",
      marker: "pwned-by-other.txt",
      command: (p) => `echo pwned > ${p.otherMem}/pwned-by-other.txt`,
    },
    {
      id: "write-self",
      desc: "write into own memory (must still work)",
      kind: "writeSelf",
      marker: "ok.txt",
      command: (p) => `echo ok > ${p.selfMem}/ok.txt`,
    },
  ];
}

interface RunResult {
  code: number | null;
  output: string;
}

function runLauncher(launcher: string[], cwd: string): RunResult {
  const [exe, ...args] = launcher;
  const res = spawnSync(exe as string, args, {
    cwd,
    encoding: "utf8",
    timeout: 15000,
  });
  return {
    code: res.status,
    output: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

/** Did the secret leak / did the malicious write land? */
function leaked(attempt: Attempt, paths: Paths, output: string): boolean {
  switch (attempt.kind) {
    case "read":
      return output.includes(SECRET);
    case "writeOther":
      return existsSync(join(paths.otherMem, attempt.marker as string));
    case "writeSelf":
      // For the positive control, "leaked" is inverted below; here it just
      // reports whether the legitimate write succeeded.
      return existsSync(join(paths.selfMem, attempt.marker as string));
  }
}

function cleanMarkers(paths: Paths): void {
  for (const f of ["pwned-by-other.txt"]) {
    rmSync(join(paths.otherMem, f), { force: true });
  }
  for (const f of ["ok.txt"]) {
    rmSync(join(paths.selfMem, f), { force: true });
  }
  rmSync(paths.link, { force: true });
}

function main(): void {
  const avail = detectSandboxBackend();
  console.log(
    `\nSandbox backend: ${avail.backend ?? "none"} — ${avail.reason}`,
  );
  if (!avail.backend) {
    console.log("No backend on this host; nothing to validate. Exiting 0.\n");
    return;
  }

  // Canonicalize: macOS /var -> /private/var (and similar) are symlinks, and
  // both Seatbelt and bwrap match on the real path. Production roots under
  // ~/.letta have no such symlink, but the temp dir does.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-spike-")));
  const agentsRoot = join(base, ".letta", "agents");
  const selfMem = join(agentsRoot, "self", "memory");
  const otherMem = join(agentsRoot, "other", "memory");
  const work = join(base, "work");
  for (const d of [selfMem, otherMem, work]) mkdirSync(d, { recursive: true });
  const otherSecret = join(otherMem, "secret.txt");
  writeFileSync(otherSecret, `${SECRET}\n`);

  const paths: Paths = {
    agentsRoot,
    selfMem,
    otherMem,
    otherSecret,
    link: join(agentsRoot, "self", "memory", "link"),
    work,
  };

  // Cross-agent policy: deny the whole agents tree, carve out only "self".
  const policy = buildFsSandboxPolicy({
    deniedRoots: [agentsRoot],
    writableRoots: [join(agentsRoot, "self")],
    restrictWrites: false,
  });

  const innerOf = (cmd: string) => ["/bin/zsh", "-c", cmd];
  const attempts = buildAttempts();

  console.log(`\n${"attempt".padEnd(22)}${"unsandboxed".padEnd(16)}sandboxed`);
  console.log("-".repeat(56));

  let failures = 0;
  for (const attempt of attempts) {
    const cmd = attempt.command(paths);

    cleanMarkers(paths);
    const bare = runLauncher(innerOf(cmd), work);
    const bareLeak = leaked(attempt, paths, bare.output);

    cleanMarkers(paths);
    const wrapped = wrapLauncher(innerOf(cmd), policy, {
      backend: avail.backend,
      bwrapPath: avail.bwrapPath,
    });
    if (!wrapped) throw new Error("wrapLauncher returned null with a backend");
    const sandboxed = runLauncher(wrapped, work);
    const sandboxedLeak = leaked(attempt, paths, sandboxed.output);

    let pass: boolean;
    if (attempt.kind === "writeSelf") {
      // Positive control: must succeed in BOTH phases.
      pass = bareLeak && sandboxedLeak;
    } else {
      // Attack: must leak unsandboxed (real bypass) and be blocked sandboxed.
      pass = bareLeak && !sandboxedLeak;
    }
    if (!pass) failures++;

    const bareCol = describe(attempt.kind, bareLeak);
    const sandCol = describe(attempt.kind, sandboxedLeak);
    const tag = pass ? "PASS" : "FAIL";
    console.log(
      `${attempt.id.padEnd(22)}${bareCol.padEnd(16)}${sandCol.padEnd(14)}${tag}`,
    );
  }

  failures += runMemoryModePhase(paths, avail, innerOf);

  rmSync(base, { recursive: true, force: true });

  console.log("-".repeat(56));
  if (failures === 0) {
    console.log(
      "\n✅ All bypasses blocked; legitimate self-write preserved.\n",
    );
  } else {
    console.log(`\n❌ ${failures} attempt(s) did not behave as expected.\n`);
    process.exit(1);
  }
}

/**
 * Memory mode as actually shipped (`buildMemoryModeSandboxPolicy`): restrict
 * writes to the memory dir, with NO read-deny on the agents tree. Runs with the
 * cwd set to the memory dir — the realistic memory-subagent cwd, which lives
 * inside `~/.letta/agents`. Validates write scoping AND that the child env
 * survives that cwd (a read-deny there would empty it under Seatbelt).
 */
function runMemoryModePhase(
  paths: Paths,
  avail: { backend: "seatbelt" | "bwrap" | null; bwrapPath?: string },
  innerOf: (cmd: string) => string[],
): number {
  if (!avail.backend) return 0;

  const policy = buildFsSandboxPolicy({
    writableRoots: [paths.selfMem],
    restrictWrites: true,
  });

  interface MemAttempt {
    id: string;
    command: string;
    want: "allowed" | "blocked";
    /** True when the effect occurred (write landed / env survived). */
    occurred: (output: string) => boolean;
  }

  const repoFile = join(paths.work, "repo-write.txt");
  const selfFile = join(paths.selfMem, "mem-ok.txt");
  const otherFile = join(paths.otherMem, "mem-pwn.txt");

  const memAttempts: MemAttempt[] = [
    {
      id: "env-intact-from-mem-cwd",
      command: '[ -n "$HOME" ] && echo ENVOK || echo ENVEMPTY',
      want: "allowed",
      occurred: (out) => out.includes("ENVOK"),
    },
    {
      id: "write-self-memory",
      command: `echo ok > ${selfFile}`,
      want: "allowed",
      occurred: () => existsSync(selfFile),
    },
    {
      id: "write-repo",
      command: `echo x > ${repoFile}`,
      want: "blocked",
      occurred: () => existsSync(repoFile),
    },
    {
      id: "write-other-memory",
      command: `echo x > ${otherFile}`,
      want: "blocked",
      occurred: () => existsSync(otherFile),
    },
  ];

  console.log(`\n${"memory-mode attempt".padEnd(28)}result`);
  console.log("-".repeat(56));

  let failures = 0;
  for (const attempt of memAttempts) {
    for (const f of [repoFile, selfFile, otherFile]) {
      rmSync(f, { force: true });
    }
    const wrapped = wrapLauncher(innerOf(attempt.command), policy, {
      backend: avail.backend,
      bwrapPath: avail.bwrapPath,
    });
    if (!wrapped) throw new Error("wrapLauncher returned null with a backend");
    // cwd = the memory dir, inside the agents tree (realistic subagent cwd).
    const res = runLauncher(wrapped, paths.selfMem);

    const occurred = attempt.occurred(res.output);
    const pass = attempt.want === "allowed" ? occurred : !occurred;
    if (!pass) failures++;

    const result =
      attempt.want === "allowed"
        ? occurred
          ? "ok"
          : "FAILED"
        : occurred
          ? "ESCAPED"
          : "blocked";
    console.log(
      `${attempt.id.padEnd(28)}${result.padEnd(16)}${pass ? "PASS" : "FAIL"}`,
    );
  }
  return failures;
}

function describe(kind: Kind, leak: boolean): string {
  if (kind === "writeSelf") return leak ? "wrote" : "blocked";
  if (kind === "writeOther") return leak ? "WROTE" : "blocked";
  return leak ? "LEAKED" : "blocked";
}

main();
