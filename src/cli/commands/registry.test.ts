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
  allocatePaste,
  clearPlaceholdersInText,
  resolvePlaceholders,
} from "@/cli/helpers/paste-registry";
import {
  __testOverrideSecretsBackend,
  clearSecretsCache,
  loadSecrets,
} from "@/utils/secrets-store";

const AGENT_ID = "agent-registry-secret-command";
const pastedInputs: string[] = [];

function pastedInput(value: string): string {
  const placeholder = `[Pasted text #${allocatePaste(value)} +1 lines]`;
  pastedInputs.push(placeholder);
  return placeholder;
}

const listAgentSecretsMock = mock((_agentId: string) =>
  Promise.resolve([] as Array<{ key: string; value: string }>),
);

const updateAgentMock = mock(
  (_agentId: string, _body: unknown, _options?: unknown) =>
    Promise.resolve({ id: AGENT_ID }),
);

const capabilities = {
  remoteMemfs: true,
  serverSideToolManagement: true,
  serverSecrets: true,
  promptRecompile: true,
  byokProviderRefresh: true,
  localModelCatalog: false,
  localMemfs: false,
};

describe("removed AgentFile commands", () => {
  test.each(["/export", "/download"])(
    "%s is not executable",
    async (command) => {
      const result = await executeCommand(command);
      expect(result.success).toBe(false);
      expect(result.notFound).toBe(true);
    },
  );
});

describe("command registry", () => {
  beforeEach(() => {
    listAgentSecretsMock.mockReset();
    updateAgentMock.mockReset();
    listAgentSecretsMock.mockResolvedValue([]);
    updateAgentMock.mockResolvedValue({ id: AGENT_ID });
    setCurrentAgentId(AGENT_ID);
    setSystemRemindersVisible(false);
    clearSecretsCache(AGENT_ID);
    __testOverrideSecretsBackend({
      capabilities,
      listAgentSecrets: listAgentSecretsMock,
      updateAgent: updateAgentMock,
    });
  });

  afterEach(() => {
    for (const input of pastedInputs.splice(0)) clearPlaceholdersInText(input);
    __testOverrideSecretsBackend(null);
    clearSecretsCache(AGENT_ID);
    setCurrentAgentId(null);
    setSystemRemindersVisible(false);
  });

  test.each([
    "FlyV1 synthetic-macaroon-one synthetic-macaroon-two",
    "synthetic\tvalue  with\tmixed whitespace",
    "-----BEGIN SYNTHETIC KEY-----\nline two\n-----END SYNTHETIC KEY-----\n",
    "synthetic value with trailing whitespace \t",
  ])("stores the complete secret value: %j", async (value) => {
    const result = await executeCommand(`/secret set registry_token ${value}`);

    expect(result).toMatchObject({
      success: true,
      output: "Secret '$REGISTRY_TOKEN' set.",
      refreshSecretsInfo: true,
    });
    expect(updateAgentMock).toHaveBeenCalledWith(AGENT_ID, {
      secrets: { REGISTRY_TOKEN: value },
    });
    expect(loadSecrets(AGENT_ID)).toEqual({ REGISTRY_TOKEN: value });
    expect(result.output).not.toContain(value);
  });

  test("resolves collapsed secret pastes before saving and releases only their entries (#3775)", async () => {
    const value = " \tFlyV1 synthetic-token\nwith whitespace \n";
    const placeholder = pastedInput(value);
    const unrelated = pastedInput("unrelated draft");
    const result = await executeCommand(
      `/secret set registry_token ${placeholder}`,
    );

    expect(result.refreshSecretsInfo).toBe(true);
    expect(updateAgentMock).toHaveBeenCalledWith(AGENT_ID, {
      secrets: { REGISTRY_TOKEN: value },
    });
    expect(resolvePlaceholders(placeholder)).toBe(placeholder);
    expect(resolvePlaceholders(unrelated)).toBe("unrelated draft");
  });

  test("resolves multiple pasted parts without reinterpreting their contents", async () => {
    const first = pastedInput("synthetic [Pasted text #999999 +1 lines]");
    const second = pastedInput("second\npart");
    await executeCommand(`/secret set registry_token ${first} ${second}`);

    expect(updateAgentMock).toHaveBeenCalledWith(AGENT_ID, {
      secrets: {
        REGISTRY_TOKEN: "synthetic [Pasted text #999999 +1 lines] second\npart",
      },
    });
    expect(resolvePlaceholders(first)).toBe(first);
    expect(resolvePlaceholders(second)).toBe(second);
  });

  test.each([false, true])(
    "rejects expired paste references without overwriting an existing secret (mixed: %s)",
    async (mixed) => {
      await executeCommand(
        "/secret set registry_token existing-synthetic-value",
      );
      updateAgentMock.mockClear();
      listAgentSecretsMock.mockClear();
      const expired = pastedInput("discarded synthetic value");
      clearPlaceholdersInText(expired);
      const live = pastedInput("live synthetic value");
      const value = mixed ? `${live} ${expired}` : expired;

      const result = await executeCommand(
        `/secret set registry_token ${value}`,
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("Paste the value again");
      expect(result.refreshSecretsInfo).toBeUndefined();
      expect(listAgentSecretsMock).not.toHaveBeenCalled();
      expect(updateAgentMock).not.toHaveBeenCalled();
      expect(loadSecrets(AGENT_ID)).toEqual({
        REGISTRY_TOKEN: "existing-synthetic-value",
      });
      expect(resolvePlaceholders(live)).toBe("live synthetic value");
    },
  );

  test("retains pasted content when the secret could not be saved", async () => {
    const value = "FlyV1 synthetic token";
    const placeholder = pastedInput(value);
    updateAgentMock.mockRejectedValueOnce(
      new Error("synthetic storage failure"),
    );

    const failed = await executeCommand(
      `/secret set registry_token ${placeholder}`,
    );
    expect(failed.output).toContain("Failed to set secret");
    expect(failed.refreshSecretsInfo).toBeUndefined();
    expect(resolvePlaceholders(placeholder)).toBe(value);

    const retried = await executeCommand(
      `/secret set registry_token ${placeholder}`,
    );
    expect(retried.refreshSecretsInfo).toBe(true);
    expect(loadSecrets(AGENT_ID)).toEqual({ REGISTRY_TOKEN: value });
    expect(resolvePlaceholders(placeholder)).toBe(placeholder);
  });

  test("does not save an empty pasted value", async () => {
    const placeholder = pastedInput("");
    const result = await executeCommand(
      `/secret set registry_token ${placeholder}`,
    );
    expect(result.output).toContain("Provide a value for the secret");
    expect(result.refreshSecretsInfo).toBeUndefined();
    expect(updateAgentMock).not.toHaveBeenCalled();
  });

  test("does not expand or release pastes for other commands", async () => {
    const placeholder = pastedInput("synthetic non-secret text");
    const result = await executeCommand(`/exit ${placeholder}`);
    expect(result).toEqual({
      success: false,
      output: "/exit does not accept arguments.",
    });
    expect(resolvePlaceholders(placeholder)).toBe("synthetic non-secret text");
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

    listAgentSecretsMock.mockResolvedValueOnce([
      { key: "REGISTRY_TOKEN", value: "registry-value" },
    ]);

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
