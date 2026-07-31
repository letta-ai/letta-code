import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..");
const scriptPath = join(
  repoRoot,
  "src",
  "skills",
  "builtin",
  "building-with-letta-agent-sdk",
  "scripts",
  "log-feedback.mjs",
);

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function makeProject(): string {
  const project = mkdtempSync(join(tmpdir(), "letta-agent-sdk-feedback-"));
  tempDirs.push(project);
  return project;
}

describe("Agent SDK feedback logger", () => {
  test("appends a private JSONL record with provenance", () => {
    const project = makeProject();
    const result = spawnSync(
      "node",
      [
        scriptPath,
        "--project",
        project,
        "--surface",
        "local",
        "--sdk-version",
        "0.5.7",
        "--run-id",
        "test-run-1",
        "--category",
        "lifecycle",
        "--friction",
        "low",
        "--summary",
        "Cleanup needed an explicit expectation",
        "--expected",
        "The session closes every owned child",
        "--observed",
        "The test observed the declared cleanup path",
        "--evidence",
        "sdk-lifecycle.test.ts: cleanup receipt",
        "--artifact",
        "receipt:test-cleanup-1",
        "--command",
        "bun test sdk-lifecycle.test.ts",
        "--suggestion",
        "Return a typed cleanup receipt",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const outputPath = join(
      project,
      ".letta",
      "letta-agent-sdk-feedback.jsonl",
    );
    const lines = readFileSync(outputPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(record.schemaVersion).toBe(1);
    expect(record.category).toBe("lifecycle");
    expect(record.friction).toBe("low");
    expect(record.runId).toBe("test-run-1");
    expect(record.evidence).toEqual(["sdk-lifecycle.test.ts: cleanup receipt"]);
    expect(record.artifacts).toEqual(["receipt:test-cleanup-1"]);
    expect(record.commands).toEqual(["bun test sdk-lifecycle.test.ts"]);
    expect(record.sdk).toEqual({
      package: "@letta-ai/letta-agent-sdk",
      version: "0.5.7",
      surface: "local",
    });
    if (process.platform !== "win32") {
      expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    }
  });

  test("rejects nonzero friction without a suggestion", () => {
    const project = makeProject();
    const result = spawnSync(
      "node",
      [
        scriptPath,
        "--project",
        project,
        "--category",
        "lifecycle",
        "--friction",
        "low",
        "--summary",
        "Cleanup was unclear",
        "--expected",
        "A cleanup receipt",
        "--observed",
        "No receipt",
        "--evidence",
        "Close returned without a receipt",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "--suggestion is required when friction is nonzero",
    );
  });
});
