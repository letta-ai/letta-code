/**
 * SessionStart feedback is rebuilt by runSessionStartHooks rather than taken
 * from the executor result, so its cap is tested through that entry point.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSessionStartHooks } from "@/hooks";
import { settingsManager } from "@/settings-manager";
import { expectPrefixPreview } from "@/test-utils/overflow-preview";
import { getOverflowDirectory } from "@/tools/impl/overflow";
import { LIMITS } from "@/tools/impl/truncation";

// Skip on Windows - the hook command uses POSIX shell quoting
const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("SessionStart hook feedback", () => {
  let baseDir: string;
  let projectDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    // Reset settings manager FIRST before changing HOME
    await settingsManager.reset();

    baseDir = join(
      tmpdir(),
      `hooks-session-start-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    // Separate HOME and project directories to avoid double-loading settings
    const fakeHome = join(baseDir, "home");
    projectDir = join(baseDir, "project");
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(projectDir, ".letta"), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    await settingsManager.initialize();
  });

  afterEach(async () => {
    await settingsManager.reset();
    process.env.HOME = originalHome;
    rmSync(baseDir, { recursive: true, force: true });
  });

  function configureSessionStartHook(command: string) {
    writeFileSync(
      join(projectDir, ".letta", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "*",
              hooks: [{ type: "command", command, quiet: true }],
            },
          ],
        },
      }),
    );
  }

  test("caps oversized stdout and saves it to a single overflow file", async () => {
    configureSessionStartHook(
      `node -e 'process.stdout.write("s".repeat(${LIMITS.HOOK_OUTPUT_CHARS + 1}))'`,
    );

    const result = await runSessionStartHooks(
      true,
      "agent-123",
      "Test Agent",
      undefined,
      projectDir,
    );

    expect(result.feedback).toHaveLength(1);
    expectPrefixPreview(result.feedback[0] ?? "", "s");
    // The executor must not also cap (and save) the stdout it hands back
    expect(readdirSync(getOverflowDirectory(projectDir))).toHaveLength(1);
  });

  test("leaves stdout within the cap untouched", async () => {
    configureSessionStartHook("echo 'Session context for agent'");

    const result = await runSessionStartHooks(
      true,
      "agent-123",
      "Test Agent",
      undefined,
      projectDir,
    );

    expect(result.feedback).toEqual(["Session context for agent"]);
  });
});
