import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  __clearExecSessionsForTests,
  exec_command,
} from "@/tools/impl/exec-command";
import { __resetBackgroundRetentionConfigForTests } from "@/tools/impl/process_manager";

const COMMAND = 'node -e "console.log(process.cwd())"';

describe("exec_command working directory recovery (#4836)", () => {
  let fallbackDir: string;
  let originalUserCwd: string | undefined;

  beforeEach(async () => {
    __resetBackgroundRetentionConfigForTests();
    fallbackDir = await realpath(
      await mkdtemp(path.join(tmpdir(), "letta-exec-fallback-")),
    );
    originalUserCwd = process.env.USER_CWD;
    process.env.USER_CWD = fallbackDir;
  });

  afterEach(async () => {
    if (originalUserCwd === undefined) delete process.env.USER_CWD;
    else process.env.USER_CWD = originalUserCwd;
    __clearExecSessionsForTests();
    __resetBackgroundRetentionConfigForTests();
    await rm(fallbackDir, { recursive: true, force: true });
  });

  test("tells the model when a deleted cwd was replaced by a fallback", async () => {
    const deletedDir = await mkdtemp(
      path.join(tmpdir(), "letta-exec-deleted-"),
    );
    await rm(deletedDir, { recursive: true, force: true });

    const note = `Note: working directory ${deletedDir} no longer exists; running in ${fallbackDir} instead.`;

    const [first, second] = await runWithRuntimeContext(
      { workingDirectory: deletedDir },
      async () => [
        await exec_command({ cmd: COMMAND }),
        await exec_command({ cmd: COMMAND }),
      ],
    );

    // It did run in the fallback...
    expect(first?.output).toContain(fallbackDir);
    // ...and the model must be told once, like the Bash tool does.
    expect(first?.output).toContain(note);
    expect(second?.output).toContain(fallbackDir);
    expect(second?.output).not.toContain("no longer exists");
  });

  test("keeps the note pending when an explicit workdir was used", async () => {
    const deletedDir = await mkdtemp(
      path.join(tmpdir(), "letta-exec-deleted-"),
    );
    await rm(deletedDir, { recursive: true, force: true });
    const explicitDir = await realpath(
      await mkdtemp(path.join(tmpdir(), "letta-exec-explicit-")),
    );

    try {
      const [explicit, implicit] = await runWithRuntimeContext(
        { workingDirectory: deletedDir },
        async () => [
          await exec_command({ cmd: COMMAND, workdir: explicitDir }),
          await exec_command({ cmd: COMMAND }),
        ],
      );

      expect(explicit?.output).toContain(explicitDir);
      expect(explicit?.output).not.toContain("no longer exists");
      expect(implicit?.output).toContain(
        `Note: working directory ${deletedDir} no longer exists`,
      );
    } finally {
      await rm(explicitDir, { recursive: true, force: true });
    }
  });

  test("control: no note when the cwd still exists", async () => {
    const liveDir = await realpath(
      await mkdtemp(path.join(tmpdir(), "letta-exec-live-")),
    );
    try {
      const result = await runWithRuntimeContext(
        { workingDirectory: liveDir },
        () => exec_command({ cmd: COMMAND }),
      );
      expect(result.output).toContain(liveDir);
      expect(result.output).not.toContain("no longer exists");
    } finally {
      await rm(liveDir, { recursive: true, force: true });
    }
  });
});
