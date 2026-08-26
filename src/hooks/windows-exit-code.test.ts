import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommandHook } from "@/hooks/executor";
import { HookExitCode, type PreToolUseHookInput } from "@/hooks/types";

describe.skipIf(process.platform !== "win32")(
  "Windows command hook exit codes",
  () => {
    let tempDir: string;
    let hookScript: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "hook-exit-code-"));
      hookScript = join(tempDir, "exit-hook.mjs");
      writeFileSync(
        hookScript,
        `const code = Number(process.argv[2]);
process.stderr.write("native exit " + code);
process.exit(code);
`,
      );
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    test("preserves native allow, error, and block statuses", async () => {
      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Agent",
        tool_input: {},
      };

      for (const [nativeCode, expected] of [
        [0, HookExitCode.ALLOW],
        [1, HookExitCode.ERROR],
        [2, HookExitCode.BLOCK],
      ] as const) {
        const result = await executeCommandHook(
          {
            type: "command",
            command: `node "${hookScript}" ${nativeCode}`,
            quiet: true,
          },
          input,
          tempDir,
        );

        expect(result.exitCode).toBe(expected);
        expect(result.stderr).toBe(`native exit ${nativeCode}`);
      }
    });

    test("reports a failing final cmdlet as error after a native block", async () => {
      const input: PreToolUseHookInput = {
        event_type: "PreToolUse",
        working_directory: tempDir,
        tool_name: "Agent",
        tool_input: {},
      };

      const result = await executeCommandHook(
        {
          type: "command",
          command: `node "${hookScript}" 2; Get-Item -LiteralPath 'Z:\\missing-letta-hook-path' -ErrorAction SilentlyContinue`,
          quiet: true,
        },
        input,
        tempDir,
      );

      expect(result.exitCode).toBe(HookExitCode.ERROR);
      expect(result.exitCode).not.toBe(HookExitCode.BLOCK);
    });
  },
);
