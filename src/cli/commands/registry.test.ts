import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setCurrentAgentId } from "@/agent/context";
import { commands, executeCommand } from "@/cli/commands/registry";
import {
  getSystemRemindersExpanded,
  getSystemRemindersVisible,
  setSystemRemindersVisible,
  toggleSystemReminderDisplay,
} from "@/cli/components/transcript-display-state";
import {
  __testOverrideSecretsBackend,
  clearSecretsCache,
} from "@/utils/secrets-store";

const AGENT_ID = "agent-registry-secret-command";

const retrieveAgentMock = mock((_agentId: string, _options?: unknown) =>
  Promise.resolve({
    secrets: [] as Array<{ key: string; value: string }>,
  }),
);

const updateAgentMock = mock(
  (_agentId: string, _body: unknown, _options?: unknown) =>
    Promise.resolve({ id: AGENT_ID }),
);

const capabilities = {
  remoteMemfs: true,
  serverSideToolManagement: true,
  serverSecrets: true,
  agentFileImportExport: true,
  promptRecompile: true,
  byokProviderRefresh: true,
  localModelCatalog: false,
  localMemfs: false,
};

describe("command registry", () => {
  beforeEach(() => {
    retrieveAgentMock.mockReset();
    updateAgentMock.mockReset();
    retrieveAgentMock.mockResolvedValue({ secrets: [] });
    updateAgentMock.mockResolvedValue({ id: AGENT_ID });
    setCurrentAgentId(AGENT_ID);
    setSystemRemindersVisible(false);
    clearSecretsCache(AGENT_ID);
    __testOverrideSecretsBackend({
      capabilities,
      retrieveAgent: retrieveAgentMock,
      updateAgent: updateAgentMock,
    });
  });

  afterEach(() => {
    __testOverrideSecretsBackend(null);
    clearSecretsCache(AGENT_ID);
    setCurrentAgentId(null);
    setSystemRemindersVisible(false);
  });

  test("propagates secrets reminder refresh metadata for secret mutations", async () => {
    const setResult = await executeCommand(
      "/secret set registry_token registry-value",
    );

    expect(setResult).toEqual({
      success: true,
      output: "Secret '$REGISTRY_TOKEN' set.",
      refreshSecretsInfo: true,
    });

    retrieveAgentMock.mockResolvedValueOnce({
      secrets: [{ key: "REGISTRY_TOKEN", value: "registry-value" }],
    });

    const unsetResult = await executeCommand("/secret unset registry_token");

    expect(unsetResult).toEqual({
      success: true,
      output: "Secret '$REGISTRY_TOKEN' unset.",
      refreshSecretsInfo: true,
    });
  });

  test("does not request a secrets reminder refresh for non-mutating commands", async () => {
    const result = await executeCommand("/secret help");

    expect(result.success).toBe(true);
    expect(result.output).toContain("Secret management commands");
    expect(result.refreshSecretsInfo).toBeUndefined();
  });

  test("system reminders are discoverable and hidden by default", async () => {
    expect(commands["/system-reminders"]).toMatchObject({
      args: "[on|off|status]",
      desc: "Show or hide system reminders",
    });
    expect(getSystemRemindersVisible()).toBe(false);
    expect(await executeCommand("/system-reminders")).toMatchObject({
      success: true,
      output:
        "System reminders are hidden. Use /system-reminders on to show them.",
    });
  });

  test("turns system reminder rows on and off", async () => {
    expect(await executeCommand("/system-reminders on")).toMatchObject({
      success: true,
      output:
        "System reminders shown. Ctrl+R expands or collapses their contents.",
    });
    expect(getSystemRemindersVisible()).toBe(true);

    toggleSystemReminderDisplay();
    expect(getSystemRemindersExpanded()).toBe(true);

    expect(await executeCommand("/system-reminders off")).toMatchObject({
      success: true,
      output: "System reminders hidden.",
    });
    expect(getSystemRemindersVisible()).toBe(false);
    expect(getSystemRemindersExpanded()).toBe(false);
  });

  test("rejects unsupported system reminder modes", async () => {
    expect(await executeCommand("/system-reminders maybe")).toMatchObject({
      success: true,
      output: "Usage: /system-reminders [on|off|status] (default is off)",
    });
    expect(
      await executeCommand("/system-reminders status extra"),
    ).toMatchObject({
      success: true,
      output: "Usage: /system-reminders [on|off|status] (default is off)",
    });
  });
});
