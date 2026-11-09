import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  setConversationId,
  setCurrentAgentId,
  setCurrentAgentName,
} from "@/agent/context";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { settingsManager } from "@/settings-manager";
import { TestDirectory } from "@/test-utils/test-fs";
import { isolateAmbientLettaTestEnv } from "@/test-utils/test-process-env";
import {
  clearCapturedToolExecutionContexts,
  clearExternalTools,
} from "@/tools/manager";
import type { RuntimeToolPolicy } from "@/types/protocol_v2";
import { handleRuntimeStartCommand } from "./commands/runtime-start";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  registerRuntimeExternalTools,
  rejectPendingExternalToolCalls,
  rejectPendingExternalToolCallsForConnection,
  updateRuntimeExternalTools,
} from "./external-tools";
import { createRuntime } from "./lifecycle";
import {
  __listenerModAdapterTestUtils,
  createListenerModAdapter,
  disposeListenerModAdapter,
} from "./mod-adapter";
import { setActiveRuntime } from "./runtime";
import { prepareListenerTurn } from "./turn-setup";
import { finishListenerTurn } from "./turn-terminal";
import type { IncomingMessage, ListenerRuntime } from "./types";
import { __listenerWarmupTestUtils } from "./warmup";

const agentId = "agent-tool-policy";
const conversationId = "conv-tool-policy";
const scope = { agent_id: agentId, conversation_id: conversationId };
const socket = {
  kind: "local" as const,
  bufferedAmount: 0,
  isOpen: () => true,
  send: () => {},
};

let directory: TestDirectory;
let listener: ListenerRuntime;
let restoreEnv: () => void;
let originalHome: string | undefined;

beforeEach(async () => {
  directory = new TestDirectory();
  originalHome = process.env.HOME;
  await settingsManager.reset();
  restoreEnv = isolateAmbientLettaTestEnv();
  process.env.HOME = directory.path;
  listener = createRuntime();
  __testSetBackend(
    new FakeHeadlessBackend(
      agentId,
      undefined,
      {},
      { modelHandle: "anthropic/claude-sonnet-4-6" },
    ),
  );
  __listenerWarmupTestUtils.setWarmupDepsForTests({
    ensureMemfsSyncedForAgent: async () => false,
    ensureSecretsHydratedForAgent: async () => {},
  });
  __listenerModAdapterTestUtils.setEnsureMemfsSyncedForAgentForTests(
    async () => false,
  );
  listener.modAdapter = createListenerModAdapter({
    globalModsDirectory: directory.createDir("mods"),
    cacheDirectory: directory.createDir("cache"),
  });
  setActiveRuntime(listener);
  await settingsManager.initialize();
});

afterEach(async () => {
  rejectPendingExternalToolCalls(listener, "test teardown");
  clearExternalTools();
  disposeListenerModAdapter(listener);
  __listenerWarmupTestUtils.resetWarmupDepsForTests();
  __listenerModAdapterTestUtils.resetForTests();
  clearCapturedToolExecutionContexts();
  setActiveRuntime(null);
  setCurrentAgentId(null);
  setCurrentAgentName(null);
  setConversationId(null);
  __testSetBackend(null);
  await settingsManager.reset();
  restoreEnv();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  directory.cleanup();
});

function registerLookup(
  connectionId: string,
  description: string,
  toolPolicy?: RuntimeToolPolicy,
) {
  registerRuntimeExternalTools(
    listener,
    connectionId,
    scope,
    [
      {
        tools: [
          {
            name: "lookup_ticket",
            description,
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    ],
    toolPolicy,
  );
}

/** Prepare one turn; omit connectionId for a process-started turn. */
async function prepareTurn(
  options: {
    connectionId?: string;
    content?: string;
    fields?: Pick<
      IncomingMessage,
      "clientToolset" | "clientToolAllowlist" | "excludeInteractiveTools"
    >;
  } = {},
) {
  const runtime = getOrCreateScopedRuntime(listener, agentId, conversationId);
  runtime.skillSources = [];
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: directory.path,
  });
  try {
    const result = await prepareListenerTurn({
      msg: {
        type: "message",
        agentId,
        conversationId,
        messages: [
          {
            role: "user",
            content:
              options.content ?? "<task-notification>done</task-notification>",
          },
        ],
        ...(options.connectionId === undefined
          ? { processOwnedTurn: true }
          : { connectionId: options.connectionId }),
        ...options.fields,
      },
      runtime,
      agentId,
      conversationId,
      workingDirectory: directory.path,
      permissionModeState: { mode: "standard" },
      turnLease: lease,
      ...(options.connectionId !== undefined
        ? { connectionId: options.connectionId }
        : {}),
    });
    if (result.kind !== "ready") throw new Error("Turn did not prepare");
    return result.preparedToolContext.preparedToolContext.clientTools;
  } finally {
    finishListenerTurn(runtime, lease, {
      stopReason: "end_turn",
      socket,
      agentId,
      conversationId,
    });
  }
}

async function toolNames(options?: Parameters<typeof prepareTurn>[0]) {
  return (await prepareTurn(options)).map((tool) => tool.name).sort();
}

test("a task notification turn uses the registering connection's tools and policy", async () => {
  const unrestricted = await toolNames();
  expect(unrestricted).toContain("Bash");

  registerLookup("sdk-session", "Lookup a ticket", {
    toolset: { base: "none" },
    allowlist: ["Read", "lookup_ticket"],
    exclude_interactive: true,
  });

  // No submitting connection and no per-input fields: only the policy applies.
  expect(await toolNames()).toEqual(["Read", "lookup_ticket"]);

  // runtime_external_tools_update sets the same policy for many runtimes.
  updateRuntimeExternalTools(listener, "sdk-session", [
    {
      runtimes: [scope],
      external_tools: [],
      tool_policy: { allowlist: ["Grep"] },
    },
  ]);
  expect(await toolNames()).toEqual(["Grep"]);

  // Disconnect removes the connection's tools and policy together.
  rejectPendingExternalToolCallsForConnection(
    listener,
    "sdk-session",
    "disconnected",
  );
  expect(await toolNames()).toEqual(unrestricted);
});

test("runtime_start applies its tool_policy to a following task notification turn", async () => {
  expect(await toolNames()).toContain("Bash");

  const responses: unknown[] = [];
  await handleRuntimeStartCommand(
    {
      type: "runtime_start",
      request_id: "runtime-start-tool-policy",
      agent_id: agentId,
      conversation_id: conversationId,
      recover_approvals: false,
      external_tools: [],
      tool_policy: { toolset: { base: "none" }, allowlist: ["Read"] },
    },
    {
      socket: { readyState: 3, send: () => {} } as never,
      connectionId: "sdk-session",
      runtime: listener,
      safeSocketSend: (_socket, payload) => {
        responses.push(payload);
        return true;
      },
      runDetachedListenerTask: () => {},
      getOrCreateScopedRuntime,
      retrieveConversation: async (id) => ({ id, agent_id: agentId }) as never,
      replaySyncStateForRuntime: async () => {},
    },
  );
  expect(responses).toContainEqual(expect.objectContaining({ success: true }));

  expect(await toolNames()).toEqual(["Read"]);
});

test("per-input tool fields apply to their own turn and only narrow the policy", async () => {
  registerLookup("sdk-session", "Lookup a ticket", {
    allowlist: ["Read", "Grep", "lookup_ticket"],
  });

  // A per-input allowlist cannot add Bash back.
  expect(
    await toolNames({
      connectionId: "sdk-session",
      content: "hello",
      fields: { clientToolAllowlist: ["Read", "Bash", "lookup_ticket"] },
    }),
  ).toEqual(["Read", "lookup_ticket"]);

  // The narrower per-input allowlist does not carry into the next turn.
  expect(await toolNames()).toEqual(["Grep", "Read", "lookup_ticket"]);
});

test("process-started turns pick duplicate tool names from the last submitting connection", async () => {
  registerLookup("gateway", "Lookup through the gateway");
  registerLookup("sdk-session", "Lookup through the SDK", {
    allowlist: ["lookup_ticket"],
  });
  registerLookup("gateway", "Lookup through the gateway");
  const lookupDescription = async (
    options?: Parameters<typeof prepareTurn>[0],
  ) =>
    (await prepareTurn(options)).find((tool) => tool.name === "lookup_ticket")
      ?.description;

  // No submitter yet: the newest registration wins.
  expect(await lookupDescription()).toBe("Lookup through the gateway");

  await prepareTurn({ connectionId: "sdk-session", content: "hello" });
  expect(await toolNames()).toEqual(["lookup_ticket"]);
  expect(await lookupDescription()).toBe("Lookup through the SDK");

  rejectPendingExternalToolCallsForConnection(
    listener,
    "sdk-session",
    "disconnected",
  );
  expect(await lookupDescription()).toBe("Lookup through the gateway");
});

test("a turn relayed by a connection without tools uses the registering connection's tools and policy", async () => {
  registerLookup("sdk-session", "Lookup through the SDK", {
    toolset: { base: "none" },
    allowlist: ["Read", "lookup_ticket"],
  });

  // Cloud delivering a queued message to this computer submits on its own
  // connection, which registered nothing for the conversation.
  const relayed = await prepareTurn({ connectionId: "cloud", content: "hi" });
  expect(relayed.map((tool) => tool.name).sort()).toEqual([
    "Read",
    "lookup_ticket",
  ]);
  expect(
    relayed.find((tool) => tool.name === "lookup_ticket")?.description,
  ).toBe("Lookup through the SDK");
});
