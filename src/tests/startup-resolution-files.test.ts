import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveStartupTarget } from "../agent/resolve-startup-agent";
import { settingsManager } from "../settings-manager";

const originalHome = process.env.HOME;
const originalCwd = process.cwd();

let testHomeDir: string;
let testProjectDir: string;

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function writeGlobalSettings(settings: Record<string, unknown>) {
  await writeJson(join(testHomeDir, ".letta", "settings.json"), settings);
}

async function writeLocalSettings(settings: Record<string, unknown>) {
  await writeJson(
    join(testProjectDir, ".letta", "settings.local.json"),
    settings,
  );
}

async function resolveFromSettings(options?: {
  existingAgentIds?: string[];
  includeLocalConversation?: boolean;
  forceNew?: boolean;
  needsModelPicker?: boolean;
}) {
  const existing = new Set(options?.existingAgentIds ?? []);

  await settingsManager.initialize();
  await settingsManager.loadLocalProjectSettings(testProjectDir);

  const localAgentId = settingsManager.getLocalLastAgentId(testProjectDir);
  const localSession = settingsManager.getLocalLastSession(testProjectDir);
  const globalAgentId = settingsManager.getGlobalLastAgentId();

  const localAgentExists = localAgentId ? existing.has(localAgentId) : false;
  const globalAgentExists = globalAgentId ? existing.has(globalAgentId) : false;
  const mergedPinnedCount =
    settingsManager.getMergedPinnedAgents(testProjectDir).length;

  return resolveStartupTarget({
    localAgentId,
    localConversationId: options?.includeLocalConversation
      ? (localSession?.conversationId ?? null)
      : null,
    localAgentExists,
    globalAgentId,
    globalAgentExists,
    mergedPinnedCount,
    forceNew: options?.forceNew ?? false,
    needsModelPicker: options?.needsModelPicker ?? false,
  });
}

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-startup-home-"));
  testProjectDir = await mkdtemp(join(tmpdir(), "letta-startup-project-"));
  process.env.HOME = testHomeDir;
  process.chdir(testProjectDir);
});

afterEach(async () => {
  await settingsManager.reset();
  process.chdir(originalCwd);
  process.env.HOME = originalHome;
  await rm(testHomeDir, { recursive: true, force: true });
  await rm(testProjectDir, { recursive: true, force: true });
});

describe("startup resolution from settings files", () => {
  test("no local/global settings files => create", async () => {
    const target = await resolveFromSettings();
    expect(target).toEqual({ action: "create" });
  });

  test("fresh dir + valid global session => resume global agent", async () => {
    await writeGlobalSettings({
      sessionsByServer: {
        "api.letta.com": {
          agentId: "agent-global",
          conversationId: "conv-global",
        },
      },
    });

    const target = await resolveFromSettings({
      existingAgentIds: ["agent-global"],
    });

    expect(target).toEqual({
      action: "resume",
      agentId: "agent-global",
    });
  });

  test("local session + valid local agent => resume local agent", async () => {
    await writeLocalSettings({
      sessionsByServer: {
        "api.letta.com": {
          agentId: "agent-local",
          conversationId: "conv-local",
        },
      },
    });

    const target = await resolveFromSettings({
      existingAgentIds: ["agent-local"],
    });

    expect(target).toEqual({
      action: "resume",
      agentId: "agent-local",
    });
  });

  test("headless parity mode: local session can carry local conversation", async () => {
    await writeLocalSettings({
      sessionsByServer: {
        "api.letta.com": {
          agentId: "agent-local",
          conversationId: "conv-local",
        },
      },
    });

    const target = await resolveFromSettings({
      existingAgentIds: ["agent-local"],
      includeLocalConversation: true,
    });

    expect(target).toEqual({
      action: "resume",
      agentId: "agent-local",
      conversationId: "conv-local",
    });
  });

  test("invalid local + valid global => fallback resume global", async () => {
    await writeLocalSettings({
      sessionsByServer: {
        "api.letta.com": {
          agentId: "agent-local-missing",
          conversationId: "conv-local",
        },
      },
    });
    await writeGlobalSettings({
      sessionsByServer: {
        "api.letta.com": {
          agentId: "agent-global",
          conversationId: "conv-global",
        },
      },
    });

    const target = await resolveFromSettings({
      existingAgentIds: ["agent-global"],
    });

    expect(target).toEqual({
      action: "resume",
      agentId: "agent-global",
    });
  });

  test("invalid local/global + global pinned => select", async () => {
    await writeLocalSettings({
      sessionsByServer: {
        "api.letta.com": {
          agentId: "agent-local-missing",
          conversationId: "conv-local",
        },
      },
    });
    await writeGlobalSettings({
      sessionsByServer: {
        "api.letta.com": {
          agentId: "agent-global-missing",
          conversationId: "conv-global",
        },
      },
      pinnedAgentsByServer: {
        "api.letta.com": ["agent-pinned-global"],
      },
    });

    const target = await resolveFromSettings();
    expect(target).toEqual({ action: "select" });
  });

  test("invalid local/global + local pinned only => select", async () => {
    await writeLocalSettings({
      sessionsByServer: {
        "api.letta.com": {
          agentId: "agent-local-missing",
          conversationId: "conv-local",
        },
      },
      pinnedAgentsByServer: {
        "api.letta.com": ["agent-pinned-local"],
      },
    });

    const target = await resolveFromSettings();
    expect(target).toEqual({ action: "select" });
  });

  test("no valid sessions + no pinned + needsModelPicker => select", async () => {
    const target = await resolveFromSettings({ needsModelPicker: true });
    expect(target).toEqual({ action: "select" });
  });

  test("forceNew always creates", async () => {
    await writeLocalSettings({
      sessionsByServer: {
        "api.letta.com": {
          agentId: "agent-local",
          conversationId: "conv-local",
        },
      },
    });
    await writeGlobalSettings({
      sessionsByServer: {
        "api.letta.com": {
          agentId: "agent-global",
          conversationId: "conv-global",
        },
      },
    });

    const target = await resolveFromSettings({
      existingAgentIds: ["agent-local", "agent-global"],
      forceNew: true,
    });

    expect(target).toEqual({ action: "create" });
  });

  test("sessionsByServer takes precedence over legacy lastAgent (global)", async () => {
    await writeGlobalSettings({
      lastAgent: "agent-legacy-global",
      sessionsByServer: {
        "api.letta.com": {
          agentId: "agent-session-global",
          conversationId: "conv-session-global",
        },
      },
    });

    const target = await resolveFromSettings({
      existingAgentIds: ["agent-session-global"],
    });

    expect(target).toEqual({
      action: "resume",
      agentId: "agent-session-global",
    });
  });

  test("sessionsByServer takes precedence over legacy lastAgent (local)", async () => {
    await writeLocalSettings({
      lastAgent: "agent-legacy-local",
      sessionsByServer: {
        "api.letta.com": {
          agentId: "agent-session-local",
          conversationId: "conv-session-local",
        },
      },
    });

    const target = await resolveFromSettings({
      existingAgentIds: ["agent-session-local"],
    });

    expect(target).toEqual({
      action: "resume",
      agentId: "agent-session-local",
    });
  });
});
