import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveStartupTarget } from "@/agent/resolve-startup-agent";
import { settingsManager } from "@/settings-manager";

const originalHome = process.env.HOME;
const originalCwd = process.cwd();
const originalLocalBackendFlag = process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
const originalLocalBackendDir = process.env.LETTA_LOCAL_BACKEND_DIR;
const originalBaseUrl = process.env.LETTA_BASE_URL;
const originalMemfsBaseUrl = process.env.LETTA_MEMFS_BASE_URL;

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
  const pinnedAgents = settingsManager.getPinnedAgents();
  const existingPinnedIds = pinnedAgents.filter((id) => existing.has(id));
  const pinnedAgentId =
    existingPinnedIds.length === 1 ? (existingPinnedIds[0] ?? null) : null;

  const pinnedAgentExists = pinnedAgentId !== null;
  const localAgentExists = localAgentId ? existing.has(localAgentId) : false;
  const globalAgentExists = globalAgentId ? existing.has(globalAgentId) : false;
  const pinnedCount = pinnedAgents.length;
  const existingPinnedCount = existingPinnedIds.length;

  return resolveStartupTarget({
    pinnedAgentId,
    pinnedAgentExists,
    pinnedCount,
    existingPinnedCount,
    localAgentId,
    localConversationId: options?.includeLocalConversation
      ? (localSession?.conversationId ?? null)
      : null,
    localAgentExists,
    globalAgentId,
    globalAgentExists,
    forceNew: options?.forceNew ?? false,
    needsModelPicker: options?.needsModelPicker ?? false,
  });
}

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-startup-home-"));
  testProjectDir = await mkdtemp(join(tmpdir(), "letta-startup-project-"));
  process.env.HOME = testHomeDir;
  delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
  delete process.env.LETTA_LOCAL_BACKEND_DIR;
  delete process.env.LETTA_BASE_URL;
  delete process.env.LETTA_MEMFS_BASE_URL;
  process.chdir(testProjectDir);
});

afterEach(async () => {
  await settingsManager.reset();
  process.chdir(originalCwd);
  process.env.HOME = originalHome;
  if (originalLocalBackendFlag === undefined) {
    delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
  } else {
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = originalLocalBackendFlag;
  }
  if (originalLocalBackendDir === undefined) {
    delete process.env.LETTA_LOCAL_BACKEND_DIR;
  } else {
    process.env.LETTA_LOCAL_BACKEND_DIR = originalLocalBackendDir;
  }
  if (originalBaseUrl === undefined) {
    delete process.env.LETTA_BASE_URL;
  } else {
    process.env.LETTA_BASE_URL = originalBaseUrl;
  }
  if (originalMemfsBaseUrl === undefined) {
    delete process.env.LETTA_MEMFS_BASE_URL;
  } else {
    process.env.LETTA_MEMFS_BASE_URL = originalMemfsBaseUrl;
  }
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

  test("api startup ignores incompatible local agent stored under api.letta.com", async () => {
    await writeGlobalSettings({
      sessionsByServer: {
        "api.letta.com": {
          agentId: "agent-local-poisoned",
          conversationId: "local-conv-poisoned",
        },
      },
      lastAgent: "agent-local-poisoned",
      lastSession: {
        agentId: "agent-local-poisoned",
        conversationId: "local-conv-poisoned",
      },
    });

    const target = await resolveFromSettings();
    expect(target).toEqual({ action: "create" });
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

  test("pinned agent takes precedence over stale local last session", async () => {
    await writeLocalSettings({
      lastAgent: "agent-last-used",
      lastSession: {
        agentId: "agent-last-used",
        conversationId: "conv-stale",
      },
    });
    await writeGlobalSettings({
      agents: [{ agentId: "agent-pinned", pinned: true }],
    });

    const target = await resolveFromSettings({
      existingAgentIds: ["agent-pinned", "agent-last-used"],
      includeLocalConversation: true,
    });

    expect(target).toEqual({
      action: "resume",
      agentId: "agent-pinned",
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
      agents: [{ agentId: "agent-pinned-global", pinned: true }],
    });

    const target = await resolveFromSettings();
    expect(target).toEqual({ action: "select" });
  });

  test("invalid local/global + pinned only => select", async () => {
    await writeLocalSettings({
      sessionsByServer: {
        "api.letta.com": {
          agentId: "agent-local-missing",
          conversationId: "conv-local",
        },
      },
    });
    await writeGlobalSettings({
      agents: [{ agentId: "agent-pinned", pinned: true }],
    });

    const target = await resolveFromSettings();
    expect(target).toEqual({ action: "select" });
  });

  test("multiple pins but only one exists in org => resume the existing pin", async () => {
    await writeGlobalSettings({
      agents: [
        { agentId: "agent-pinned-live", pinned: true },
        { agentId: "agent-pinned-stale-1", pinned: true },
        { agentId: "agent-pinned-stale-2", pinned: true },
      ],
    });

    // Two pins belong to other orgs / were deleted and don't resolve here.
    const target = await resolveFromSettings({
      existingAgentIds: ["agent-pinned-live"],
    });

    expect(target).toEqual({
      action: "resume",
      agentId: "agent-pinned-live",
    });
  });

  test("multiple stale pins + valid global LRU => resume LRU, not select", async () => {
    await writeGlobalSettings({
      sessionsByServer: {
        "api.letta.com": {
          agentId: "agent-global",
          conversationId: "conv-global",
        },
      },
      agents: [
        { agentId: "agent-pinned-stale-1", pinned: true },
        { agentId: "agent-pinned-stale-2", pinned: true },
      ],
    });

    // Neither pin resolves in this org, so the LRU should win instead of the
    // selector firing on a raw pin count.
    const target = await resolveFromSettings({
      existingAgentIds: ["agent-global"],
    });

    expect(target).toEqual({
      action: "resume",
      agentId: "agent-global",
    });
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

  test("local backend sessions are keyed by storage directory, not api.letta.com", async () => {
    const storageDir = join(testHomeDir, "lc-local-backend-a");
    const localKey = `local:${resolve(storageDir)}`;
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "1";
    process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;

    await settingsManager.initialize();
    await settingsManager.loadLocalProjectSettings(testProjectDir);
    settingsManager.persistSession(
      "agent-local-valid",
      "local-conv-valid",
      testProjectDir,
    );

    const globalSettings = settingsManager.getSettings();
    const localSettings =
      settingsManager.getLocalProjectSettings(testProjectDir);
    expect(globalSettings.sessionsByServer?.[localKey]).toEqual({
      agentId: "agent-local-valid",
      conversationId: "local-conv-valid",
    });
    expect(localSettings.sessionsByServer?.[localKey]).toEqual({
      agentId: "agent-local-valid",
      conversationId: "local-conv-valid",
    });
    expect(globalSettings.sessionsByServer?.["api.letta.com"]).toBeUndefined();
    expect(localSettings.sessionsByServer?.["api.letta.com"]).toBeUndefined();
    expect(globalSettings.lastAgent).toBeNull();
    expect(globalSettings.lastSession).toBeUndefined();
  });

  test("local backend reads the session for the active storage directory", async () => {
    const storageDirA = join(testHomeDir, "lc-local-backend-a");
    const storageDirB = join(testHomeDir, "lc-local-backend-b");
    const localKeyA = `local:${resolve(storageDirA)}`;
    const localKeyB = `local:${resolve(storageDirB)}`;
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "1";
    process.env.LETTA_LOCAL_BACKEND_DIR = storageDirB;

    await writeLocalSettings({
      lastSession: {
        agentId: "agent-legacy-stale",
        conversationId: "conv-legacy-stale",
      },
      sessionsByServer: {
        [localKeyA]: {
          agentId: "agent-local-a",
          conversationId: "conv-a",
        },
        [localKeyB]: {
          agentId: "agent-local-b",
          conversationId: "conv-b",
        },
        "api.letta.com": {
          agentId: "agent-api-stale",
          conversationId: "conv-api-stale",
        },
      },
    });

    await settingsManager.initialize();
    await settingsManager.loadLocalProjectSettings(testProjectDir);

    expect(settingsManager.getLocalLastSession(testProjectDir)).toEqual({
      agentId: "agent-local-b",
      conversationId: "conv-b",
    });
  });

  test("local backend ignores legacy API agent fallbacks", async () => {
    const storageDir = join(testHomeDir, "lc-local-backend");
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "1";
    process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;

    await writeLocalSettings({
      lastAgent: "agent-api-legacy",
      lastSession: {
        agentId: "agent-api-legacy",
        conversationId: "conv-api-legacy",
      },
      sessionsByServer: {
        "api.letta.com": {
          agentId: "agent-api-session",
          conversationId: "conv-api-session",
        },
      },
    });

    await settingsManager.initialize();
    await settingsManager.loadLocalProjectSettings(testProjectDir);

    expect(settingsManager.getLocalLastSession(testProjectDir)).toBeNull();
    expect(settingsManager.getLocalLastAgentId(testProjectDir)).toBeNull();
  });

  test("API backend ignores legacy local-backend agent fallbacks", async () => {
    await writeLocalSettings({
      lastAgent: "agent-local-legacy",
      lastSession: {
        agentId: "agent-local-legacy",
        conversationId: "local-conv-legacy",
      },
    });

    await settingsManager.initialize();
    await settingsManager.loadLocalProjectSettings(testProjectDir);

    expect(settingsManager.getLocalLastSession(testProjectDir)).toBeNull();
    expect(settingsManager.getLocalLastAgentId(testProjectDir)).toBeNull();
  });
});
