import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { detectSandboxBackend } from "@/sandbox/availability";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";
import { wrapSubagentLauncher } from "./sandbox";
import {
  composeSubagentChildEnv,
  prepareSubagentChildEnv,
} from "./subagent-launcher";

const parentAgentId = "agent-doctor-sandbox-parent";

// These assertions run even on hosts without a kernel sandbox.
test("memory launch prepares temp storage before child imports and leaves the parent env unchanged", () => {
  const parentProcessEnv = {
    TMPDIR: "/readonly/tmp",
    TMP: "/readonly/tmp",
    TEMP: "/readonly/tmp",
  };
  const child = prepareSubagentChildEnv({
    parentProcessEnv,
    parentAgentId,
    launchProfile: "memory-subagent",
    inheritedPrimaryRoot: null,
  });
  expect(child.TMPDIR).toBe(join(homedir(), ".letta", "tmp"));
  expect(child.TMP).toBe(child.TMPDIR);
  expect(child.TEMP).toBe(child.TMPDIR);
  expect(existsSync(child.TMPDIR ?? "")).toBe(true);
  expect(parentProcessEnv.TMPDIR).toBe("/readonly/tmp");
});

test("ordinary subagents preserve the caller's temp configuration", () => {
  const child = prepareSubagentChildEnv({
    parentProcessEnv: { TMPDIR: "/caller/temp" },
    parentAgentId,
    launchProfile: "default",
    inheritedPrimaryRoot: null,
  });
  expect(child.TMPDIR).toBe("/caller/temp");
  expect(child.TMP).toBeUndefined();
});

const availability = detectSandboxBackend();
for (const backendMode of ["api", "local"] as const) {
  test.skipIf(!availability.backend)(
    `Bash can run the evidence CLI inside the ${backendMode} memory sandbox`,
    () => {
      const fixtureDir = mkdtempSync(join(tmpdir(), "doctor-sandbox-probe-"));
      const storageDir = join(homedir(), ".letta", "sandbox-probe-local");
      const memoryRoot =
        backendMode === "local"
          ? join(storageDir, "memfs", parentAgentId, "memory")
          : join(homedir(), ".letta", "agents", parentAgentId, "memory");
      const probe = join(fixtureDir, "probe.ts");
      const repoRoot = resolve(import.meta.dir, "../../..");
      const cliEntry = join(repoRoot, "src/index.ts");
      mkdirSync(memoryRoot, { recursive: true });
      mkdirSync(storageDir, { recursive: true });
      // Run the actual Bash implementation, including the output allocator that
      // failed before any command could execute in the reported doctor trace.
      writeFileSync(
        probe,
        `
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bash } from ${JSON.stringify(join(repoRoot, "src/tools/impl/bash.ts"))};
import { settingsManager } from ${JSON.stringify(join(repoRoot, "src/settings-manager.ts"))};
await settingsManager.initialize();
const result = await bash({ command: "letta messages --help", description: "Read evidence CLI help", timeout: 15000 });
if (result.status !== "success" || !result.content.some(p => p.text.includes("--include-errors"))) {
  throw new Error(JSON.stringify(result));
}
const scratch = mkdtempSync(join(tmpdir(), "evidence-"));
writeFileSync(join(scratch, "evidence.json"), "{}");
for (const forbidden of [join(process.cwd(), "unexpected-write")]) {
  let denied = false;
  try { writeFileSync(forbidden, "unexpected"); } catch { denied = true; }
  if (!denied) throw new Error("Sandbox allowed write outside harness: " + forbidden);
}
console.log("SANDBOX-EVIDENCE-OK");
`,
      );
      const parentEnv = createIsolatedCliTestEnv({
        HOME: homedir(),
        USER_CWD: fixtureDir,
        TMPDIR: tmpdir(),
        TMP: tmpdir(),
        TEMP: tmpdir(),
        LETTA_SANDBOX: undefined,
        LETTA_SCRATCHPAD: undefined,
        LETTA_CODE_BIN: process.execPath,
        LETTA_CODE_BIN_ARGS_JSON: JSON.stringify([
          "--loader=.md:text",
          "--loader=.mdx:text",
          "--loader=.txt:text",
          "run",
          cliEntry,
        ]),
        LETTA_FS_SANDBOX: "1",
        LETTA_DISABLE_EXTENSIONS: "1",
        DO_NOT_TRACK: "1",
        NO_COLOR: "1",
      });
      const options = {
        parentProcessEnv: parentEnv,
        parentAgentId,
        backendMode,
        launchProfile: "memory-subagent" as const,
        inheritedPrimaryRoot: memoryRoot,
        localBackendStorageDir: storageDir,
      };
      const wrapped = wrapSubagentLauncher({
        launcher: {
          command: process.execPath,
          args: [
            "--loader=.md:text",
            "--loader=.mdx:text",
            "--loader=.txt:text",
            "run",
            probe,
          ],
        },
        launchProfile: "memory-subagent",
        backendMode,
        memoryRoots: [memoryRoot],
        inheritedPrimaryRoot: memoryRoot,
        localBackendStorageDir: storageDir,
        env: parentEnv,
        availability,
      });
      if (!wrapped) throw new Error("Expected a kernel sandbox");
      const run = (env: NodeJS.ProcessEnv) =>
        spawnSync(wrapped.command, wrapped.args, {
          cwd: fixtureDir,
          env: { ...env, ...wrapped.sandboxEnv },
          encoding: "utf8",
          timeout: 25000,
        });
      try {
        const before = run(composeSubagentChildEnv(options));
        expect(before.status).not.toBe(0);
        expect(before.stderr).toContain("letta-background-");
        const after = run(prepareSubagentChildEnv(options));
        expect(after.status, after.stderr || after.error?.message).toBe(0);
        expect(after.stdout).toContain("SANDBOX-EVIDENCE-OK");
        expect(existsSync(join(fixtureDir, "unexpected-write"))).toBe(false);
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
    55000,
  );
}
