import { afterEach, describe, expect, test } from "bun:test";
import TaskDescriptionRaw from "./descriptions/Task.md";
import { TASK_HARNESSES } from "./impl/task-agent-selection";
import type { JsonSchema } from "./model-facing-tool";
import TaskSchema from "./schemas/Task.json";
import { stripComputerFromTaskSchema } from "./task-tool-assets";

const taskSchema = TaskSchema as JsonSchema;
const taskDescription = (TaskDescriptionRaw as string).trim();

describe("stripComputerFromTaskSchema", () => {
  test("removes the computer property from the real Task schema", () => {
    expect(taskSchema.properties?.computer).toBeDefined();
    const stripped = stripComputerFromTaskSchema(taskSchema);
    expect(stripped.properties?.computer).toBeUndefined();
    expect(stripped.properties?.prompt).toBeDefined();
    expect(stripped.properties?.harness).toBeDefined();
    expect(stripped.required).toEqual(taskSchema.required);
  });

  test("does not mutate the input schema", () => {
    stripComputerFromTaskSchema(taskSchema);
    expect(taskSchema.properties?.computer).toBeDefined();
  });

  test("returns schemas without a computer property unchanged", () => {
    const schema: JsonSchema = { properties: { prompt: { type: "string" } } };
    expect(stripComputerFromTaskSchema(schema)).toBe(schema);
  });
});

describe("task() computer guard", () => {
  test("task.ts resolves and rejects computer args before spawning", async () => {
    const source = await Bun.file(
      new URL("./impl/task.ts", import.meta.url),
    ).text();
    const launchStart = source.indexOf("export async function launchSubagent(");
    const guardIndex = source.indexOf("resolveLaunchComputer({", launchStart);
    const rejectIndex = source.indexOf("resolvedComputer.error", guardIndex);
    const spawnIndex = source.indexOf(
      "spawnBackgroundSubagentTask({",
      launchStart,
    );
    expect(guardIndex).toBeGreaterThan(-1);
    expect(rejectIndex).toBeGreaterThan(-1);
    expect(spawnIndex).toBeGreaterThan(-1);
    expect(rejectIndex).toBeLessThan(spawnIndex);
  });

  test("the routing guard lives in subagent-computer.ts", async () => {
    const source = await Bun.file(
      new URL("./impl/subagent-computer.ts", import.meta.url),
    ).text();
    expect(source).toContain(
      "The computer option requires a Letta Cloud backend",
    );
    expect(source).toContain("capabilities.environmentRouting");
  });
});

describe("Task agent selection fields", () => {
  test("harness is an optional enum of letta and the external workers", () => {
    expect(taskSchema.required).not.toContain("harness");
    expect(taskSchema.properties?.harness).toMatchObject({
      type: "string",
      enum: ["letta", "claude-code", "codex", "cursor", "opencode"],
    });
    const schemaEnum = (taskSchema.properties?.harness as { enum: string[] })
      .enum;
    expect([...schemaEnum].sort()).toEqual([...TASK_HARNESSES].sort());
  });
  test("subagent_type is an optional string and agent_type is gone", () => {
    expect(taskSchema.required).not.toContain("subagent_type");
    expect(taskSchema.properties?.subagent_type).toMatchObject({
      type: "string",
    });
    expect(taskSchema.properties?.agent_type).toBeUndefined();
    expect(taskSchema.additionalProperties).toBe(false);
  });
  test("the model-facing description does not mention agent_type", () => {
    expect(taskDescription).not.toMatch(/\bagent_type\b/);
  });
  // Launch behavior is covered by the existing routing and fork-receipt suites.
});

describe("resolveBackendSpecificToolAssets Task dispatch", () => {
  const originalBaseUrl = process.env.LETTA_BASE_URL;

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.LETTA_BASE_URL;
    } else {
      process.env.LETTA_BASE_URL = originalBaseUrl;
    }
  });

  test("strips computer for a non-cloud server", async () => {
    process.env.LETTA_BASE_URL = "http://localhost:8283";
    const { resolveBackendSpecificToolAssets } = await import(
      "./task-tool-assets"
    );
    const resolved = await resolveBackendSpecificToolAssets(
      "Task",
      taskDescription,
      taskSchema,
    );
    expect(resolved.inputSchema.properties?.computer).toBeUndefined();
    expect(resolved.description).toBe(taskDescription);
  });

  test("keeps computer for the Cloud server", async () => {
    process.env.LETTA_BASE_URL = "https://api.letta.com";
    const { resolveBackendSpecificToolAssets } = await import(
      "./task-tool-assets"
    );
    const resolved = await resolveBackendSpecificToolAssets(
      "Task",
      taskDescription,
      taskSchema,
    );
    expect(resolved.inputSchema.properties?.computer).toBeDefined();
    expect(resolved.description).toBe(taskDescription);
  });
});
