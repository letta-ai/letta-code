import { describe, expect, test } from "bun:test";
import {
  parseChannelModelCommand,
  type RuntimeCommandAbortResult,
  type RuntimeCommandClient,
  type RuntimeCommandExecuteResult,
  type RuntimeCommandListModelsResult,
  type RuntimeCommandScope,
  type RuntimeCommandUpdateModelResult,
  runChannelCancelCommand,
  runChannelModelListCommand,
  runChannelModelUpdateCommand,
  runChannelReflectionCommand,
  runChannelReloadCommand,
} from "@/channels/command-runtime-executor";
import type { ListModelsResponseModelEntry } from "@/types/protocol_v2";

const RUNTIME: RuntimeCommandScope = {
  agent_id: "agent-1",
  conversation_id: "conv-1",
};

const MODEL_ENTRIES: ListModelsResponseModelEntry[] = [
  {
    id: "model-opus",
    handle: "anthropic/claude-opus",
    label: "Claude Opus",
    description: "Best quality",
    isDefault: true,
  },
  {
    id: "model-fast",
    handle: "anthropic/claude-haiku",
    label: "Claude Haiku",
    description: "Fastest",
    isFeatured: true,
  },
];

type RecordedCall =
  | { method: "listModels" }
  | {
      method: "updateModel";
      params: { runtime: RuntimeCommandScope; modelIdentifier: string };
    }
  | {
      method: "abortMessage";
      params: { runtime: RuntimeCommandScope; runId: string | null };
    }
  | {
      method: "executeCommand";
      params: {
        runtime: RuntimeCommandScope;
        commandId: "reflect" | "reload";
        args?: string;
      };
    };

function createFakeClient(
  overrides: {
    listModels?: RuntimeCommandListModelsResult | Error;
    updateModel?: RuntimeCommandUpdateModelResult | Error;
    abortMessage?: RuntimeCommandAbortResult | Error;
    executeCommand?: RuntimeCommandExecuteResult | Error;
  } = {},
): { client: RuntimeCommandClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const resolveOrThrow = async <T>(
    value: T | Error | undefined,
    fallback: T,
  ) => {
    if (value instanceof Error) throw value;
    return value ?? fallback;
  };
  const client: RuntimeCommandClient = {
    listModels: async () => {
      calls.push({ method: "listModels" });
      return resolveOrThrow(overrides.listModels, {
        success: true,
        entries: MODEL_ENTRIES,
      });
    },
    updateModel: async (params) => {
      calls.push({ method: "updateModel", params });
      return resolveOrThrow(overrides.updateModel, { success: true });
    },
    abortMessage: async (params) => {
      calls.push({ method: "abortMessage", params });
      return resolveOrThrow(overrides.abortMessage, {
        success: true,
        aborted: true,
      });
    },
    executeCommand: async (params) => {
      calls.push({ method: "executeCommand", params });
      return resolveOrThrow(overrides.executeCommand, {
        success: true,
        output: "done",
      });
    },
  };
  return { client, calls };
}

describe("parseChannelModelCommand", () => {
  test("empty or whitespace args mean show the current model", () => {
    expect(parseChannelModelCommand("")).toEqual({ kind: "current" });
    expect(parseChannelModelCommand("   ")).toEqual({ kind: "current" });
  });

  test("list is matched case-insensitively", () => {
    expect(parseChannelModelCommand("list")).toEqual({ kind: "list" });
    expect(parseChannelModelCommand(" LIST ")).toEqual({ kind: "list" });
  });

  test("anything else is a trimmed model identifier", () => {
    expect(parseChannelModelCommand(" anthropic/claude-opus ")).toEqual({
      kind: "update",
      modelIdentifier: "anthropic/claude-opus",
    });
  });
});

describe("runChannelModelListCommand", () => {
  test("sends list_models and renders the model selector", async () => {
    const { client, calls } = createFakeClient({
      listModels: {
        success: true,
        entries: MODEL_ENTRIES,
        availableHandles: ["anthropic/claude-opus"],
        error: undefined,
      },
    });

    const result = await runChannelModelListCommand({
      channelId: "telegram",
      client,
      recentHandles: ["anthropic/claude-opus"],
    });

    expect(calls).toEqual([{ method: "listModels" }]);
    expect(result.handled).toBe(true);
    expect(result.text).toContain("Telegram model selector");
    expect(result.text).toContain("Recent models:");
    expect(result.text).toContain("Available models:");
    expect(result.text).toContain("Claude Opus");
    expect(result.text).toContain("/model model-opus");
    // Availability was reported, so no fallback note is rendered.
    expect(result.text).not.toContain("Availability lookup failed");
    expect(result.text).not.toContain("Available model data was not returned");
  });

  test("null availableHandles renders the lookup-failed note", async () => {
    const { client } = createFakeClient({
      listModels: {
        success: true,
        entries: MODEL_ENTRIES,
        availableHandles: null,
      },
    });

    const result = await runChannelModelListCommand({
      channelId: "telegram",
      client,
    });

    expect(result.text).toContain(
      "Availability lookup failed; showing built-in recommended models.",
    );
  });

  test("absent availableHandles renders the not-returned note", async () => {
    const { client } = createFakeClient({
      listModels: { success: true, entries: MODEL_ENTRIES },
    });

    const result = await runChannelModelListCommand({
      channelId: "telegram",
      client,
    });

    expect(result.text).toContain(
      "Available model data was not returned; showing built-in recommended models.",
    );
  });

  test("failure renders the unavailable message with the server error", async () => {
    const { client } = createFakeClient({
      listModels: { success: false, entries: [], error: "backend down" },
    });

    const result = await runChannelModelListCommand({
      channelId: "telegram",
      client,
    });

    expect(result.text).toBe(
      "Telegram could not load the model list: backend down",
    );
  });

  test("failure without a server error uses the default copy", async () => {
    const { client } = createFakeClient({
      listModels: { success: false, entries: [] },
    });

    const result = await runChannelModelListCommand({
      channelId: "telegram",
      client,
    });

    expect(result.text).toBe(
      "Telegram could not load the model list: Failed to list models",
    );
  });

  test("uses the injected display-name resolver", async () => {
    const { client } = createFakeClient();

    const result = await runChannelModelListCommand({
      channelId: "my-plugin",
      client,
      channelDisplayName: () => "My Plugin",
    });

    expect(result.text).toContain("My Plugin model selector");
  });

  test("transport errors propagate to the host", async () => {
    const { client } = createFakeClient({
      listModels: new Error("relay timeout"),
    });

    await expect(
      runChannelModelListCommand({ channelId: "telegram", client }),
    ).rejects.toThrow("relay timeout");
  });
});

describe("runChannelModelUpdateCommand", () => {
  test("sends update_model for the runtime and renders success", async () => {
    const { client, calls } = createFakeClient({
      updateModel: {
        success: true,
        modelHandle: "anthropic/claude-opus",
        appliedTo: "conversation",
      },
    });

    const result = await runChannelModelUpdateCommand({
      channelId: "telegram",
      client,
      runtime: RUNTIME,
      modelIdentifier: "opus",
      resolveModelLabel: (handle) =>
        handle === "anthropic/claude-opus" ? "Claude Opus" : undefined,
    });

    expect(calls).toEqual([
      {
        method: "updateModel",
        params: { runtime: RUNTIME, modelIdentifier: "opus" },
      },
    ]);
    expect(result.success).toBe(true);
    expect(result.modelHandle).toBe("anthropic/claude-opus");
    expect(result.text).toBe(
      "Telegram updated this conversation's model to Claude Opus (anthropic/claude-opus).",
    );
  });

  test("agent-scoped updates say agent and fall back to the identifier label", async () => {
    const { client } = createFakeClient({
      updateModel: { success: true, appliedTo: "agent" },
    });

    const result = await runChannelModelUpdateCommand({
      channelId: "telegram",
      client,
      runtime: RUNTIME,
      modelIdentifier: "opus",
    });

    // No server handle and no label resolver: the identifier stands in for
    // both, so the parenthetical handle suffix collapses.
    expect(result.modelHandle).toBe("opus");
    expect(result.text).toBe("Telegram updated this agent's model to opus.");
  });

  test("failure renders the update-failed message with the server error", async () => {
    const { client } = createFakeClient({
      updateModel: { success: false, error: "unknown model" },
    });

    const result = await runChannelModelUpdateCommand({
      channelId: "telegram",
      client,
      runtime: RUNTIME,
      modelIdentifier: "bogus",
    });

    expect(result.success).toBe(false);
    expect(result.modelHandle).toBeUndefined();
    expect(result.text).toBe(
      "Telegram could not switch this chat's routed model to bogus: unknown model",
    );
  });

  test("failure without a server error uses the default copy", async () => {
    const { client } = createFakeClient({
      updateModel: { success: false },
    });

    const result = await runChannelModelUpdateCommand({
      channelId: "telegram",
      client,
      runtime: RUNTIME,
      modelIdentifier: "bogus",
    });

    expect(result.text).toBe(
      "Telegram could not switch this chat's routed model to bogus: Failed to update model",
    );
  });

  test("transport errors propagate to the host", async () => {
    const { client } = createFakeClient({
      updateModel: new Error("relay timeout"),
    });

    await expect(
      runChannelModelUpdateCommand({
        channelId: "telegram",
        client,
        runtime: RUNTIME,
        modelIdentifier: "opus",
      }),
    ).rejects.toThrow("relay timeout");
  });
});

describe("runChannelCancelCommand", () => {
  test("sends abort_message with a null run id", async () => {
    const { client, calls } = createFakeClient({
      abortMessage: { success: true, aborted: true },
    });

    const result = await runChannelCancelCommand({
      client,
      runtime: RUNTIME,
      channelId: "telegram",
    });

    expect(calls).toEqual([
      { method: "abortMessage", params: { runtime: RUNTIME, runId: null } },
    ]);
    expect(result.cancelled).toBe(true);
    expect(result.text).toBe(
      "Telegram cancelled the in-progress agent turn for this chat.",
    );
  });

  test("no active turn renders the no-active-turn message", async () => {
    const { client } = createFakeClient({
      abortMessage: { success: true, aborted: false },
    });

    const result = await runChannelCancelCommand({
      client,
      runtime: RUNTIME,
      channelId: "telegram",
    });

    expect(result.cancelled).toBe(false);
    expect(result.text).toBe(
      "Telegram received /cancel, but there is no in-progress agent turn to cancel for this chat.",
    );
  });

  test("an unsuccessful abort is not a cancellation even if aborted is set", async () => {
    const { client } = createFakeClient({
      abortMessage: { success: false, aborted: true },
    });

    const result = await runChannelCancelCommand({
      client,
      runtime: RUNTIME,
      channelId: "telegram",
    });

    expect(result.cancelled).toBe(false);
  });

  test("omits text when no channel id is provided (host renders)", async () => {
    const { client } = createFakeClient({
      abortMessage: { success: true, aborted: true },
    });

    const result = await runChannelCancelCommand({ client, runtime: RUNTIME });

    expect(result.cancelled).toBe(true);
    expect(result.text).toBeUndefined();
  });

  test("transport errors propagate to the host", async () => {
    const { client } = createFakeClient({
      abortMessage: new Error("relay timeout"),
    });

    await expect(
      runChannelCancelCommand({ client, runtime: RUNTIME }),
    ).rejects.toThrow("relay timeout");
  });
});

describe("runChannelReflectionCommand and runChannelReloadCommand", () => {
  test("reflection sends execute_command reflect and relays its output", async () => {
    const { client, calls } = createFakeClient({
      executeCommand: { success: true, output: "Reflection started." },
    });

    const result = await runChannelReflectionCommand({
      client,
      runtime: RUNTIME,
    });

    expect(calls).toEqual([
      {
        method: "executeCommand",
        params: { runtime: RUNTIME, commandId: "reflect" },
      },
    ]);
    expect(result).toEqual({ handled: true, text: "Reflection started." });
  });

  test("reload sends execute_command reload and relays its output", async () => {
    const { client, calls } = createFakeClient({
      executeCommand: { success: true, output: "Reloaded." },
    });

    const result = await runChannelReloadCommand({ client, runtime: RUNTIME });

    expect(calls).toEqual([
      {
        method: "executeCommand",
        params: { runtime: RUNTIME, commandId: "reload" },
      },
    ]);
    expect(result).toEqual({ handled: true, text: "Reloaded." });
  });

  test("trimmed args are forwarded; blank args are omitted", async () => {
    const { client, calls } = createFakeClient();

    await runChannelReflectionCommand({
      client,
      runtime: RUNTIME,
      args: "  focus on memory  ",
    });
    await runChannelReloadCommand({ client, runtime: RUNTIME, args: "   " });

    expect(calls).toEqual([
      {
        method: "executeCommand",
        params: {
          runtime: RUNTIME,
          commandId: "reflect",
          args: "focus on memory",
        },
      },
      {
        method: "executeCommand",
        params: { runtime: RUNTIME, commandId: "reload" },
      },
    ]);
  });

  test("failed executions still relay the server-rendered output", async () => {
    const { client } = createFakeClient({
      executeCommand: { success: false, output: "Reload failed: no agent." },
    });

    const result = await runChannelReloadCommand({ client, runtime: RUNTIME });

    expect(result).toEqual({
      handled: true,
      text: "Reload failed: no agent.",
    });
  });

  test("transport errors propagate to the host", async () => {
    const { client } = createFakeClient({
      executeCommand: new Error("relay timeout"),
    });

    await expect(
      runChannelReflectionCommand({ client, runtime: RUNTIME }),
    ).rejects.toThrow("relay timeout");
  });
});
