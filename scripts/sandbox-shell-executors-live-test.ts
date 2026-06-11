#!/usr/bin/env bun
/**
 * Live bring-up for the non-Bash shell executors under the parent cross-agent
 * sandbox: Codex `exec_command` (pipe AND pty) and the Gemini `run_shell_command`
 * path (`shell`). 3a wrapped only the `Bash` tool; this confirms the other two
 * executors are now kernel-confined too — so the kernel owns the whole shell
 * surface.
 *
 * Drives the real exec_command()/shell() with the flag on against a throwaway
 * HOME and asserts: another agent's memory is read-denied, while self memory
 * still reads. The pty case is the delicate one (node-pty + sandbox-exec).
 *
 *   HOME="$(mktemp -d)" bun scripts/sandbox-shell-executors-live-test.ts
 */
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runWithRuntimeContext } from "@/runtime-context";
import { detectSandboxBackend } from "@/sandbox/availability";
import { exec_command } from "@/tools/impl/exec-command";
import { shell } from "@/tools/impl/shell";

const home = realpathSync(homedir());
if (!home.startsWith("/private/") && !home.startsWith("/tmp")) {
  console.error(`Refusing to run: HOME=${home} is not a throwaway dir.`);
  process.exit(1);
}
const avail = detectSandboxBackend();
console.log(`backend: ${avail.backend ?? "none"} — ${avail.reason}`);
if (!avail.backend) process.exit(1);

const SELF = "agent-self";
const agents = join(home, ".letta", "agents");
const selfMem = join(agents, SELF, "memory");
const otherMem = join(agents, "agent-other", "memory");
mkdirSync(selfMem, { recursive: true });
mkdirSync(otherMem, { recursive: true });
writeFileSync(join(selfMem, "mine.md"), "SELFDATA");
writeFileSync(join(otherMem, "secret.md"), "TOPSECRET");

const repoCwd = process.cwd();
process.env.LETTA_FS_SANDBOX = "1";
process.env.AGENT_ID = SELF;
process.env.MEMORY_DIR = selfMem;

const otherSecret = join(otherMem, "secret.md");
const selfFile = join(selfMem, "mine.md");

let failures = 0;
function check(label: string, output: string, expectDenied: boolean): void {
  const leaked = /TOPSECRET/.test(output);
  // Seatbelt denies with "operation not permitted"; bwrap masks the path with a
  // tmpfs so it reports as absent ("No such file or directory"). Accept both —
  // the security criterion is that the secret never leaks (`!leaked`).
  const denied =
    /not permitted|operation not permitted|no such file or directory/i.test(
      output,
    );
  const sawSelf = /SELFDATA/.test(output);
  const pass = expectDenied ? denied && !leaked : sawSelf;
  if (!pass) failures++;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${label} :: ${output.replace(/\s+/g, " ").trim().slice(0, 110)}`,
  );
}

await runWithRuntimeContext(
  { workingDirectory: repoCwd, agentId: SELF },
  async () => {
    console.log("\n=== exec_command (pipe) ===");
    check(
      "read other (DENY)",
      (await exec_command({ cmd: `cat ${otherSecret}`, yield_time_ms: 4000 }))
        .output,
      true,
    );
    check(
      "read self  (allow)",
      (await exec_command({ cmd: `cat ${selfFile}`, yield_time_ms: 4000 }))
        .output,
      false,
    );

    console.log("\n=== exec_command (pty) ===");
    check(
      "read other (DENY)",
      (
        await exec_command({
          cmd: `cat ${otherSecret}`,
          tty: true,
          yield_time_ms: 5000,
        })
      ).output,
      true,
    );
    check(
      "read self  (allow)",
      (
        await exec_command({
          cmd: `cat ${selfFile}`,
          tty: true,
          yield_time_ms: 5000,
        })
      ).output,
      false,
    );

    console.log("\n=== shell (run_shell_command path) ===");
    check(
      "read other (DENY)",
      (await shell({ command: ["bash", "-lc", `cat ${otherSecret}`] })).output,
      true,
    );
    check(
      "read self  (allow)",
      (await shell({ command: ["bash", "-lc", `cat ${selfFile}`] })).output,
      false,
    );
  },
);

rmSync(join(home, ".letta"), { recursive: true, force: true });
console.log(
  `\n${failures === 0 ? "✓ all shell executors confined" : `✗ ${failures} case(s) failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
