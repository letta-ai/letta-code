#!/usr/bin/env bun
/**
 * Live bring-up for the parent-agent Bash cross-agent sandbox (step 3).
 *
 * Exercises the *real* shipped `applyParentShellSandbox` end-to-end: it builds a
 * wrapped launcher, then spawns actual shell commands through it to confirm the
 * kernel enforces the cross-agent policy — self memory read/write works, other
 * agents' memory is read- and write-denied (including via a symlink escape),
 * the repo/tmp stay writable, and the child env survives (cwd = repo, so no
 * Seatbelt empty-env).
 *
 * Must be launched with HOME pointed at a throwaway dir so the agents tree it
 * walls off is a fake one we own:
 *
 *   HOME="$(mktemp -d)" bun scripts/sandbox-bash-live-test.ts
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectSandboxBackend } from "@/sandbox/availability";
import { applyParentShellSandbox } from "@/tools/impl/shell-sandbox";

const home = realpathSync(homedir());
if (!home.startsWith("/private/") && !home.startsWith("/tmp")) {
  console.error(
    `Refusing to run: HOME=${home} is not a throwaway dir. Launch with HOME="$(mktemp -d)".`,
  );
  process.exit(1);
}

const avail = detectSandboxBackend();
console.log(`backend: ${avail.backend ?? "none"} — ${avail.reason}`);
if (!avail.backend) process.exit(0);

const agents = join(home, ".letta", "agents");
const selfMem = join(agents, "self", "memory");
const otherMem = join(agents, "other", "memory");
mkdirSync(selfMem, { recursive: true });
mkdirSync(otherMem, { recursive: true });
writeFileSync(join(selfMem, "mine.md"), "self-data");
writeFileSync(join(otherMem, "secret.md"), "TOPSECRET");

// The parent agent's cwd is the repo — outside the fake agents tree.
const repoCwd = process.cwd();
const env: NodeJS.ProcessEnv = {
  ...process.env,
  LETTA_FS_SANDBOX: "1",
  MEMORY_DIR: selfMem,
};

const result = applyParentShellSandbox(
  ["/bin/zsh", "-c", "__PROBE__"],
  repoCwd,
  env,
);
console.log(
  `wrapped: ${result.backend ?? "NO"}  launcher[0]=${result.launcher[0]}`,
);
if (!result.backend) {
  console.error("applyParentShellSandbox did not wrap — aborting.");
  rmSync(join(home, ".letta"), { recursive: true, force: true });
  process.exit(1);
}

function probe(label: string, cmd: string): void {
  const launcher = result.launcher.map((a) => (a === "__PROBE__" ? cmd : a));
  const r = spawnSync(launcher[0] as string, launcher.slice(1), {
    cwd: repoCwd,
    env: result.env,
    encoding: "utf8",
    timeout: 15000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\n/g, " ").trim();
  console.log(`  ${label}: exit=${r.status} ${out}`);
}

console.log("\nprobe matrix (expect self+repo+tmp ok, other DENIED):");
probe("env-intact", 'echo "envkeys=$(env | wc -l | tr -d " ")"');
probe("read-self      (allow)", `cat ${join(selfMem, "mine.md")}`);
probe(
  "write-self     (allow)",
  `echo x > ${join(selfMem, "w.md")}; echo WROTE_SELF`,
);
probe(
  "write-repo     (allow)",
  `echo x > /tmp/sandbox-bash-live.txt; echo WROTE_TMP`,
);
probe("read-other     (DENY) ", `cat ${join(otherMem, "secret.md")}`);
probe(
  "write-other    (DENY) ",
  `echo x > ${join(otherMem, "evil.md")}; echo WROTE_OTHER`,
);
probe(
  "symlink-escape (DENY) ",
  `ln -sf ${otherMem} /tmp/sb-live-link; cat /tmp/sb-live-link/secret.md`,
);
probe("enumerate-tree (DENY) ", `ls ${agents}; echo LISTED`);

rmSync(join(home, ".letta"), { recursive: true, force: true });
rmSync("/tmp/sb-live-link", { force: true });
rmSync("/tmp/sandbox-bash-live.txt", { force: true });
console.log();
