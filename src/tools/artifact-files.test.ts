import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimentManager } from "@/experiments/manager";
import { settingsManager } from "@/settings-manager";
import {
  read_artifact_file,
  write_artifact_file,
} from "@/tools/impl/artifact-files";
import {
  clearCapturedToolExecutionContexts,
  prepareToolExecutionContextForModel,
} from "@/tools/manager";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalArtifactsDir = process.env.LETTA_ARTIFACTS_DIR;

let testHomeDir = "";

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-artifacts-home-"));
  process.env.HOME = testHomeDir;
  process.env.USERPROFILE = testHomeDir;
  process.env.LETTA_ARTIFACTS_DIR = join(testHomeDir, ".letta", "artifacts");
  await settingsManager.initialize();
});

afterEach(async () => {
  clearCapturedToolExecutionContexts();
  await settingsManager.reset();
  if (testHomeDir) {
    await rm(testHomeDir, { recursive: true, force: true });
    testHomeDir = "";
  }
  process.env.HOME = originalHome;
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  if (originalArtifactsDir === undefined) {
    delete process.env.LETTA_ARTIFACTS_DIR;
  } else {
    process.env.LETTA_ARTIFACTS_DIR = originalArtifactsDir;
  }
});

describe("artifact file tools", () => {
  test("are disabled until the artifacts experiment is enabled", async () => {
    await expect(
      write_artifact_file({
        path: "todo-app/ui/index.html",
        content: "<h1>Todo</h1>",
      }),
    ).rejects.toThrow("artifacts experiment is disabled");
  });

  test("write and read files under ~/.letta/artifacts", async () => {
    experimentManager.set("artifacts", true);

    const writeResult = await write_artifact_file({
      path: "artifacts/todo-app/ui/index.html",
      content: "<h1>Todo</h1>",
    });

    expect(writeResult.path).toBe("todo-app/ui/index.html");
    expect(writeResult.bytes).toBeGreaterThan(0);
    await expect(
      readFile(
        join(
          testHomeDir,
          ".letta",
          "artifacts",
          "todo-app",
          "ui",
          "index.html",
        ),
        "utf8",
      ),
    ).resolves.toBe("<h1>Todo</h1>");

    const readResult = await read_artifact_file({
      path: "external/artifacts/todo-app/ui/index.html",
    });
    expect(readResult).toEqual({
      path: "todo-app/ui/index.html",
      content: "<h1>Todo</h1>",
      encoding: "utf8",
    });
  });

  test("rejects paths that escape the artifacts root", async () => {
    experimentManager.set("artifacts", true);

    await expect(
      write_artifact_file({ path: "../outside.txt", content: "no" }),
    ).rejects.toThrow("cannot contain '..'");
  });

  test("experiment gates model-facing artifact tools", async () => {
    const disabled = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
    );
    expect(disabled.loadedToolNames).not.toContain("read_artifact_file");
    expect(disabled.loadedToolNames).not.toContain("write_artifact_file");

    experimentManager.set("artifacts", true);
    const enabled = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
    );
    expect(enabled.loadedToolNames).toContain("read_artifact_file");
    expect(enabled.loadedToolNames).toContain("write_artifact_file");
  });
});
