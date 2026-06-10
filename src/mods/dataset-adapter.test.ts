import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatasetAdapterCommandRunner } from "@/mods/dataset-adapter";
import {
  DATASET_ADAPTER_SCHEMA_VERSION,
  normalizeDatasetAdapterEvaluation,
  normalizeDatasetTaskIds,
  runDatasetAdapterCommand,
} from "@/mods/dataset-adapter";

describe("dataset adapter command schema", () => {
  test("normalizes task ids at host-filesystem adapter boundaries", () => {
    expect(normalizeDatasetTaskIds([" extract-elf\n", "", " foo "])).toEqual([
      "extract-elf",
      "foo",
    ]);
    expect(normalizeDatasetTaskIds(["\n"])).toBeUndefined();
  });

  test("normalizes adapter scores from task results", () => {
    const request = {
      action: "evaluate_candidate" as const,
      artifactsDir: "/tmp/run/dataset",
      candidate: {
        fileName: "mod.ts",
        index: 1,
        modDir: "/tmp/run/mods",
        path: "/tmp/run/mods/mod.ts",
      },
      dataset: "terminalbench",
      repoRoot: "/tmp/repo",
      runDir: "/tmp/run",
      schemaVersion: DATASET_ADAPTER_SCHEMA_VERSION,
      subset: "smoke",
      trials: 1,
    };

    const normalized = normalizeDatasetAdapterEvaluation(
      {
        tasks: [
          { costUsd: 0.4, durationMs: 10, passed: true, taskId: "a" },
          { costUsd: 0.1, durationMs: 20, passed: false, taskId: "b" },
        ],
      },
      request,
    );

    expect(normalized.score).toEqual({
      costUsd: 0.5,
      durationMs: 30,
      passed: 1,
      passRate: 0.5,
      total: 2,
    });
    expect(normalized.dataset).toBe("terminalbench");
    expect(normalized.passed).toBe(false);
    expect(normalized.subset).toBe("smoke");
  });

  test("writes request file and parses command JSON response", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "letta-dataset-adapter-"));
    try {
      const requestPath = path.join(tempDir, "request.json");
      const runner: DatasetAdapterCommandRunner = async (
        command,
        args,
        options,
      ) => {
        expect(command).toBe("adapter-bin");
        expect(args).toEqual([
          "--flag",
          "evaluate_candidate",
          "--request",
          requestPath,
        ]);
        expect(options.env.LETTA_MODS_DIR).toBe("/tmp/run/mods");
        const request = JSON.parse(readFileSync(requestPath, "utf8"));
        expect(request.candidate.path).toBe("/tmp/run/mods/mod.ts");
        expect(request.taskIds).toEqual(["extract-elf"]);
        return {
          args,
          command,
          cwd: options.cwd,
          durationMs: 7,
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            dataset: "terminalbench",
            passed: true,
            score: { costUsd: 0.25, passed: 1, passRate: 1, total: 1 },
            tasks: [{ passed: true, taskId: "extract-elf" }],
          }),
          timedOut: false,
        };
      };

      const result = await runDatasetAdapterCommand({
        baseEnv: { LETTA_MODS_DIR: "/tmp/run/mods" },
        config: {
          adapter: { args: ["--flag"], command: "adapter-bin" },
          dataset: "terminalbench",
          subset: "smoke",
          taskIds: ["extract-elf\n"],
          trials: 1,
        },
        repoRoot: "/tmp/repo",
        request: {
          action: "evaluate_candidate",
          artifactsDir: "/tmp/run/dataset",
          candidate: {
            fileName: "mod.ts",
            index: 1,
            modDir: "/tmp/run/mods",
            path: "/tmp/run/mods/mod.ts",
          },
          dataset: "terminalbench",
          repoRoot: "/tmp/repo",
          runDir: "/tmp/run",
          schemaVersion: DATASET_ADAPTER_SCHEMA_VERSION,
          subset: "smoke",
          taskIds: ["extract-elf"],
          trials: 1,
        },
        requestPath,
        runner,
      });

      expect(result.response.score.passRate).toBe(1);
      expect(result.response.tasks[0]?.taskId).toBe("extract-elf");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
