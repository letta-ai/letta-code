import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runPostToolUseFailureHooks,
  runPostToolUseHooks,
  runPreToolUseHooks,
} from "@/hooks";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import {
  clearCapturedToolExecutionContexts,
  executeTool,
  prepareToolExecutionContextForSpecificTools,
} from "@/tools/manager";

function shellQuote(value: string): string {
  if (process.platform === "win32") return `'${value.replaceAll("'", "''")}'`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function nodeCommand(scriptPath: string, block = false): string {
  return `node ${shellQuote(scriptPath)}${block ? "; exit 2" : ""}`;
}

function readPayload(
  directory: string,
  event: string,
): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(directory, `${event}.json`), "utf8"),
  ) as Record<string, unknown>;
}

function readPayloads(directory: string): Array<Record<string, unknown>> {
  return readFileSync(join(directory, "hook-events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("model-facing tool hook aliases", () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  let tempDir: string;
  let hookScript: string;

  beforeEach(async () => {
    await settingsManager.reset();
    const root = mkdtempSync(join(tmpdir(), "hook-tool-alias-"));
    fakeHome = join(root, "home");
    tempDir = join(root, "project");
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(tempDir, ".letta"), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    await settingsManager.initialize();

    hookScript = join(tempDir, "capture-hook.mjs");
    writeFileSync(
      hookScript,
      `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const input = JSON.parse(readFileSync(0, "utf8"));
writeFileSync(join(process.cwd(), input.event_type + ".json"), JSON.stringify(input));
appendFileSync(join(process.cwd(), "hook-events.ndjson"), JSON.stringify(input) + "\\n");
`,
    );
  });

  afterEach(async () => {
    clearCapturedToolExecutionContexts();
    await settingsManager.reset();
    process.env.HOME = originalHome;
    rmSync(join(tempDir, ".."), { recursive: true, force: true });
  });

  test("matches aliases and reports Agent for every tool outcome", async () => {
    const hook = { type: "command", command: nodeCommand(hookScript) };
    writeFileSync(
      join(tempDir, ".letta", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Agent", hooks: [hook] }],
          PostToolUse: [{ matcher: "Agent", hooks: [hook] }],
          PostToolUseFailure: [{ matcher: "Agent", hooks: [hook] }],
        },
      }),
    );

    const names = ["Agent", "Task"] as const;
    const pre = await runPreToolUseHooks(names, {}, "call-1", tempDir);
    const post = await runPostToolUseHooks(
      names,
      {},
      { status: "success", output: "done" },
      "call-1",
      tempDir,
    );
    const failure = await runPostToolUseFailureHooks(
      names,
      {},
      "failed",
      "Error",
      "call-1",
      tempDir,
    );

    expect(pre.results).toHaveLength(1);
    expect(post.results).toHaveLength(1);
    expect(failure.results).toHaveLength(1);
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
      expect(readPayload(tempDir, event).tool_name).toBe("Agent");
    }
  });

  test("maps internal Task execution to an Agent matcher", async () => {
    writeFileSync(
      join(tempDir, ".letta", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Task",
              hooks: [{ type: "command", command: nodeCommand(hookScript) }],
            },
            {
              matcher: "Agent",
              hooks: [
                { type: "command", command: nodeCommand(hookScript, true) },
              ],
            },
          ],
        },
      }),
    );

    const prepared = await runWithRuntimeContext(
      { workingDirectory: tempDir },
      () => prepareToolExecutionContextForSpecificTools(["Task"]),
    );
    const result = await runWithRuntimeContext(
      { workingDirectory: tempDir },
      () =>
        executeTool(
          "Agent",
          {
            description: "invalid test dispatch",
            prompt: "reject the unknown test agent type",
            subagent_type: "nonexistent-test-agent",
          },
          { toolContextId: prepared.contextId },
        ),
    );

    expect(result.status).toBe("error");
    expect(String(result.toolReturn)).toContain("blocked by hook");
    const payloads = readPayloads(tempDir);
    expect(payloads).toHaveLength(2);
    expect(payloads.map((payload) => payload.tool_name)).toEqual([
      "Agent",
      "Agent",
    ]);
  });

  test("reports mapped names from built-in post and exception paths", async () => {
    const hook = { type: "command", command: nodeCommand(hookScript) };
    writeFileSync(
      join(tempDir, ".letta", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: "glob|read_file", hooks: [hook] }],
          PostToolUseFailure: [{ matcher: "read_file", hooks: [hook] }],
        },
      }),
    );

    const prepared = await runWithRuntimeContext(
      { workingDirectory: tempDir },
      () =>
        prepareToolExecutionContextForSpecificTools([
          "glob_gemini",
          "read_file_gemini",
        ]),
    );
    const globResult = await runWithRuntimeContext(
      { workingDirectory: tempDir },
      () =>
        executeTool(
          "glob",
          { dir_path: tempDir, pattern: "*.missing" },
          { toolContextId: prepared.contextId },
        ),
    );
    expect(globResult.status).toBe("success");
    expect(readPayload(tempDir, "PostToolUse").tool_name).toBe("glob");

    const readResult = await runWithRuntimeContext(
      { workingDirectory: tempDir },
      () =>
        executeTool(
          "read_file",
          { file_path: join(tempDir, "missing.txt") },
          { toolContextId: prepared.contextId },
        ),
    );
    expect(readResult.status).toBe("error");
    expect(readPayload(tempDir, "PostToolUse").tool_name).toBe("read_file");
    expect(readPayload(tempDir, "PostToolUseFailure").tool_name).toBe(
      "read_file",
    );
  });
});
