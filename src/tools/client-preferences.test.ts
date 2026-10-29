import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsManager } from "@/settings-manager";
import type { ClientPreferences } from "@/types/client-preferences";
import {
  getStoredClientPreferences,
  isClientPreferences,
  normalizeClientPreferences,
  replaceClientPreferences,
} from "./client-preferences";

const originalHome = process.env.HOME;
let testHomeDir: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-client-preferences-"));
  process.env.HOME = testHomeDir;
  await settingsManager.initialize();
});

afterEach(async () => {
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe("client preference normalization", () => {
  test("canonicalizes aliases to sorted, unique public tool names without mutating input", () => {
    const input = {
      toolset: {
        include: [
          "Read",
          "Task",
          "AskUserQuestionAsync",
          "Agent",
          "AskUserQuestion",
          "Read",
        ],
      },
    };
    const original = structuredClone(input);
    const normalized = normalizeClientPreferences(input);
    expect(normalized).toEqual({
      toolset: { include: ["Agent", "AskUserQuestion", "Read"] },
    });
    expect(normalizeClientPreferences(normalized)).toEqual(normalized);
    expect(input).toEqual(original);
    expect(isClientPreferences(input)).toBe(true);
  });

  test("empty snapshots and empty include lists both mean clear", () => {
    expect(normalizeClientPreferences({})).toEqual({});
    expect(normalizeClientPreferences({ toolset: { include: [] } })).toEqual(
      {},
    );
  });

  test.each(
    [
      null,
      [],
      "Read",
      { unexpected: true },
      { toolset: null },
      { toolset: {} },
      { toolset: { include: "Read" } },
      { toolset: { include: [1] } },
      { toolset: { include: ["Read"], base: "none" } },
      { toolset: { include: ["not-a-bundled-tool"] } },
      { toolset: { include: ["Read", ""] } },
    ].map((value) => ({ value })),
  )("rejects invalid preferences: %j", ({ value }) => {
    expect(() => normalizeClientPreferences(value)).toThrow();
    expect(isClientPreferences(value)).toBe(false);
  });
});

describe("stored client preferences", () => {
  test("a new process loads the persisted snapshot", async () => {
    const preferences = { toolset: { include: ["AskUserQuestion"] } };
    replaceClientPreferences("agent-restart", "conv-restart", preferences);
    await settingsManager.flush();
    const child = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `import { settingsManager } from "@/settings-manager";
       import { getStoredClientPreferences } from "@/tools/client-preferences";
       await settingsManager.initialize();
       console.log(JSON.stringify(getStoredClientPreferences("agent-restart", "conv-restart")));`,
      ],
      { env: { ...process.env, HOME: testHomeDir } },
    );
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual(preferences);
  });

  test("scopes snapshots by agent and conversation, without default or parent inheritance", () => {
    const preferences = { toolset: { include: ["Read"] } };
    replaceClientPreferences("agent-a", null, preferences);
    replaceClientPreferences("agent-a", "conv-parent", {
      toolset: { include: ["Bash"] },
    });
    expect(getStoredClientPreferences("agent-a")).toEqual(preferences);
    expect(getStoredClientPreferences("agent-a", "default")).toEqual(
      preferences,
    );
    expect(getStoredClientPreferences("agent-a", "conv-parent")).toEqual({
      toolset: { include: ["Bash"] },
    });
    expect(getStoredClientPreferences("agent-a", "conv-child")).toEqual({});
    expect(getStoredClientPreferences("agent-b", "conv-parent")).toEqual({});
    expect(getStoredClientPreferences("agent-b")).toEqual({});
  });

  test("supports agent-free and virtual-default scope keys", () => {
    const preferences = { toolset: { include: ["Read"] } };
    replaceClientPreferences(null, "conv-free", preferences);
    replaceClientPreferences(null, undefined, {
      toolset: { include: ["Bash"] },
    });
    expect(getStoredClientPreferences(null, "conv-free")).toEqual(preferences);
    expect(
      settingsManager.getClientPreferences("conv-free", "conv-free"),
    ).toEqual(preferences);
    expect(getStoredClientPreferences(null, "conv-other")).toEqual({});
    for (const conversationId of [undefined, null, "", "default"]) {
      expect(getStoredClientPreferences(null, conversationId)).toEqual({
        toolset: { include: ["Bash"] },
      });
    }
  });

  test("equivalent normalized snapshots do not call updateSettings", () => {
    replaceClientPreferences("agent-a", "conv-a", {
      toolset: { include: ["Read", "Task"] },
    });
    const update = spyOn(settingsManager, "updateSettings");
    try {
      replaceClientPreferences("agent-a", "conv-a", {
        toolset: { include: ["Agent", "Read", "Task", "Read"] },
      });
      expect(update).not.toHaveBeenCalled();
      replaceClientPreferences("agent-a", "conv-a", {});
      expect(update).toHaveBeenCalledTimes(1);
      replaceClientPreferences("agent-a", "conv-a", {
        toolset: { include: [] },
      });
      replaceClientPreferences("agent-new", "conv-new", {});
      expect(update).toHaveBeenCalledTimes(1);
    } finally {
      update.mockRestore();
    }
  });

  test.each([{}, { toolset: { include: [] } }] as ClientPreferences[])(
    "clears only the target snapshot with %j",
    (clear) => {
      const preferences = { toolset: { include: ["Read"] } };
      replaceClientPreferences("agent-a", "conv-a", preferences);
      replaceClientPreferences("agent-a", "conv-b", preferences);
      replaceClientPreferences("agent-a", "conv-a", clear);
      expect(getStoredClientPreferences("agent-a", "conv-a")).toEqual({});
      expect(getStoredClientPreferences("agent-a", "conv-b")).toEqual(
        preferences,
      );
    },
  );

  test("replaces rather than merges and protects stored snapshots from caller mutation", () => {
    const input = { toolset: { include: ["Read", "Bash"] } };
    replaceClientPreferences("agent-a", "conv-a", input);
    input.toolset.include.push("Grep");
    replaceClientPreferences("agent-a", "conv-a", {
      toolset: { include: ["Read"] },
    });
    const result = getStoredClientPreferences("agent-a", "conv-a");
    result.toolset?.include.push("Bash");
    expect(getStoredClientPreferences("agent-a", "conv-a")).toEqual({
      toolset: { include: ["Read"] },
    });
  });

  test("persists normalized snapshots and clears across settings reload", async () => {
    replaceClientPreferences("agent-a", "conv-a", {
      toolset: { include: ["Task", "Read", "Agent"] },
    });
    replaceClientPreferences("agent-a", null, {
      toolset: { include: ["Bash"] },
    });
    replaceClientPreferences(null, "conv-free", {
      toolset: { include: ["Grep"] },
    });
    await settingsManager.reset();
    await settingsManager.initialize();
    expect(getStoredClientPreferences("agent-a", "conv-a")).toEqual({
      toolset: { include: ["Agent", "Read"] },
    });
    expect(getStoredClientPreferences("agent-a")).toEqual({
      toolset: { include: ["Bash"] },
    });
    expect(getStoredClientPreferences(null, "conv-free")).toEqual({
      toolset: { include: ["Grep"] },
    });
    replaceClientPreferences("agent-a", "conv-a", {});
    await settingsManager.reset();
    await settingsManager.initialize();
    expect(getStoredClientPreferences("agent-a", "conv-a")).toEqual({});
    expect(getStoredClientPreferences("agent-a")).toEqual({
      toolset: { include: ["Bash"] },
    });
  });
});
