import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { getCurrentAgentId } from "../agent/context";
import { permissionMode } from "../permissions/mode";
import {
  getCurrentWorkingDirectory,
  runWithRuntimeContext,
} from "../runtime-context";
import { read } from "../tools/impl/Read";

describe("runtime context isolation", () => {
  test("isolates agent and permission mode across concurrent async contexts", async () => {
    const [resultA, resultB] = await Promise.all([
      runWithRuntimeContext(
        {
          agentId: "agent-a",
          permissionMode: "plan",
        },
        async () => {
          await Promise.resolve();
          return {
            agentId: getCurrentAgentId(),
            permissionMode: permissionMode.getMode(),
          };
        },
      ),
      runWithRuntimeContext(
        {
          agentId: "agent-b",
          permissionMode: "acceptEdits",
        },
        async () => {
          await Promise.resolve();
          return {
            agentId: getCurrentAgentId(),
            permissionMode: permissionMode.getMode(),
          };
        },
      ),
    ]);

    expect(resultA).toEqual({
      agentId: "agent-a",
      permissionMode: "plan",
    });
    expect(resultB).toEqual({
      agentId: "agent-b",
      permissionMode: "acceptEdits",
    });
  });

  test("isolates working directory across concurrent tool reads", async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-runtime-context-"));
    const repoA = join(tempRoot, "repo-a");
    const repoB = join(tempRoot, "repo-b");
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    await writeFile(join(repoA, "note.txt"), "from-a");
    await writeFile(join(repoB, "note.txt"), "from-b");

    try {
      const [resultA, resultB] = await Promise.all([
        runWithRuntimeContext({ workingDirectory: repoA }, async () => {
          await Promise.resolve();
          return {
            cwd: getCurrentWorkingDirectory(),
            result: await read({ file_path: "note.txt" }),
          };
        }),
        runWithRuntimeContext({ workingDirectory: repoB }, async () => {
          await Promise.resolve();
          return {
            cwd: getCurrentWorkingDirectory(),
            result: await read({ file_path: "note.txt" }),
          };
        }),
      ]);

      expect(resultA.cwd).toBe(repoA);
      expect(resultB.cwd).toBe(repoB);
      expect(resultA.result.content).toContain("from-a");
      expect(resultB.result.content).toContain("from-b");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
