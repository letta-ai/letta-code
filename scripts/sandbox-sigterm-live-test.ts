#!/usr/bin/env bun
/**
 * Live check for SIGTERM propagation through the sandbox wrapper (doc task 3).
 *
 * Unlike `sandbox-exec` (which execs *into* the target, same PID), `bwrap`
 * stays a **parent** of the sandboxed child in a new namespace — so a signal to
 * the wrapper does not automatically hit the inner shell. The real spawn path
 * (`src/tools/impl/shell-runner.ts`) spawns `detached: true` and kills the
 * process **group** with `process.kill(-pid, "SIGTERM")`; bwrap also carries
 * `--die-with-parent`. This mirrors that and verifies the inner shell actually
 * dies, for both the group-kill path and a plain `child.kill()`.
 *
 *   HOME="$(mktemp -d)" bun scripts/sandbox-sigterm-live-test.ts
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildCrossAgentSandboxPolicy } from "@/permissions/sandbox-policy";
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

mkdirSync(join(home, ".letta", "agents", "agent-self"), { recursive: true });
const policy = buildCrossAgentSandboxPolicy({
  selfRoots: [join(home, ".letta", "agents", "agent-self")],
});

const SHELL = process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let failures = 0;
async function trial(label: string, killGroup: boolean): Promise<void> {
  const pidFile = join(home, `sig.${killGroup ? "grp" : "plain"}.pid`);
  rmSync(pidFile, { force: true });

  const wrapped = wrapLauncher(
    [SHELL, "-c", `echo $$ > ${pidFile}; sleep 30`],
    policy,
    { backend: avail.backend, bwrapPath: avail.bwrapPath },
  );
  if (!wrapped) {
    failures++;
    console.log(`FAIL  ${label} :: wrapLauncher returned null`);
    return;
  }

  const child = spawn(wrapped[0] as string, wrapped.slice(1), {
    detached: true,
    stdio: "ignore",
  });

  // Wait for the inner shell to record its PID (proves it actually launched).
  for (let i = 0; i < 50 && !existsSync(pidFile); i++) await sleep(50);
  if (!existsSync(pidFile)) {
    failures++;
    console.log(`FAIL  ${label} :: inner shell never wrote its PID`);
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {}
    return;
  }
  const innerPid = Number(readFileSync(pidFile, "utf8").trim());

  // Kill the way shell-runner does (group) or the naive way (the wrapper PID).
  try {
    if (killGroup) process.kill(-(child.pid as number), "SIGTERM");
    else child.kill("SIGTERM");
  } catch (e) {
    console.log(`       ${label}: kill threw ${(e as Error).message}`);
  }

  // The inner shell must be gone within ~2s.
  let gone = false;
  for (let i = 0; i < 40; i++) {
    if (!alive(innerPid)) {
      gone = true;
      break;
    }
    await sleep(50);
  }
  if (!gone) failures++;
  console.log(
    `${gone ? "PASS" : "FAIL"}  ${label} :: wrapperPid=${child.pid} innerPid=${innerPid} -> innerKilled=${gone ? "YES" : "NO (LEAKED)"}`,
  );

  // Clean up any survivor + the process group.
  if (!gone) {
    try {
      process.kill(innerPid, "SIGKILL");
    } catch {}
  }
  try {
    process.kill(-(child.pid as number), "SIGKILL");
  } catch {}
  rmSync(pidFile, { force: true });
}

console.log("\n=== SIGTERM propagation through the wrapper ===");
await trial("group-kill (process.kill(-pid) — the shell-runner path)", true);
await trial("plain-kill (child.kill())", false);

rmSync(join(home, ".letta"), { recursive: true, force: true });
console.log(
  `\n${failures === 0 ? "✓ SIGTERM reaches the inner shell (both kill paths)" : `✗ ${failures} case(s) failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
