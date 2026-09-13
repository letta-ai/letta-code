import { afterEach, expect, test } from "bun:test";
import type {
  ExternalToolDefinitionPayload,
  RuntimeExternalToolsUpdateGroup,
  RuntimeScope,
} from "@/types/app-server-protocol";
import { createRoutedRuntimeRegistrationRefresher } from "./routed-runtime-registration";
import { __testOverrideLoadRoutes, clearAllRoutes } from "./routing";
import type { ChannelTurnSource } from "./types";

const runtime: RuntimeScope = {
  agent_id: "agent-1",
  conversation_id: "conv-1",
};

function createSource(
  nextRuntime: RuntimeScope = runtime,
  accountId = "acct-1",
): ChannelTurnSource {
  return {
    channel: "slack",
    accountId,
    chatId: `chat-${nextRuntime.conversation_id}`,
    chatType: "channel",
    threadId: null,
    agentId: nextRuntime.agent_id,
    conversationId: nextRuntime.conversation_id,
  };
}

function createTool(
  description = "Deliver a channel message",
): ExternalToolDefinitionPayload {
  return {
    name: "MessageChannel",
    description,
    parameters: { type: "object", properties: {} },
  };
}

afterEach(() => {
  clearAllRoutes();
  __testOverrideLoadRoutes(null);
});

test("publishes routed tools in one batch without starting runtimes", async () => {
  __testOverrideLoadRoutes(() => null);
  const updates: RuntimeExternalToolsUpdateGroup[][] = [];
  const routedSources = new Map<string, ChannelTurnSource[]>();
  const refresher = createRoutedRuntimeRegistrationRefresher({
    registry: { resolveRoutedTurnSources: () => [createSource()] },
    publisher: {
      publish: async (nextUpdates, nextRoutedSources) => {
        if (nextUpdates.length > 0) updates.push([...nextUpdates]);
        for (const update of nextRoutedSources) {
          routedSources.set(update.runtime.conversation_id, update.sources);
        }
      },
    },
    channelNames: ["slack"],
    buildTool: async () => createTool(),
  });

  await refresher.refresh();

  expect(updates).toEqual([
    [
      {
        runtimes: [runtime],
        external_tools: [{ tools: [createTool()] }],
      },
    ],
  ]);
  expect(routedSources.get(runtime.conversation_id)).toEqual([createSource()]);
  refresher.close();
});

test("groups hundreds of identical routed tools into one update", async () => {
  __testOverrideLoadRoutes(() => null);
  const sources = Array.from({ length: 350 }, (_, index) =>
    createSource({
      agent_id: "agent-1",
      conversation_id: `conv-${index}`,
    }),
  );
  const updates: RuntimeExternalToolsUpdateGroup[][] = [];
  let toolBuilds = 0;
  const refresher = createRoutedRuntimeRegistrationRefresher({
    registry: { resolveRoutedTurnSources: () => sources },
    publisher: {
      publish: async (nextUpdates) => {
        updates.push([...nextUpdates]);
      },
    },
    channelNames: ["slack"],
    buildTool: async () => {
      toolBuilds++;
      return createTool();
    },
  });

  await refresher.refresh();

  expect(updates).toHaveLength(1);
  expect(updates[0]).toHaveLength(1);
  expect(updates[0]?.[0]?.runtimes).toHaveLength(350);
  expect(updates[0]?.[0]?.external_tools).toEqual([{ tools: [createTool()] }]);
  expect(toolBuilds).toBe(1);
  refresher.close();
});

test("publishes only changed schemas and removed runtime registrations", async () => {
  __testOverrideLoadRoutes(() => null);
  let sources = [createSource()];
  let description = "Initial tool";
  const updates: RuntimeExternalToolsUpdateGroup[][] = [];
  const cleared: RuntimeScope[] = [];
  const refresher = createRoutedRuntimeRegistrationRefresher({
    registry: { resolveRoutedTurnSources: () => sources },
    publisher: {
      publish: async (nextUpdates, nextRoutedSources) => {
        if (nextUpdates.length > 0) updates.push([...nextUpdates]);
        for (const update of nextRoutedSources) {
          if (update.sources.length === 0) cleared.push(update.runtime);
        }
      },
    },
    channelNames: ["slack"],
    buildTool: async () => createTool(description),
  });

  await refresher.refresh();
  await refresher.refresh();
  description = "Updated tool";
  await refresher.refresh();
  sources = [];
  await refresher.refresh();

  expect(updates).toHaveLength(3);
  expect(updates[1]?.[0]?.external_tools).toEqual([
    { tools: [createTool("Updated tool")] },
  ]);
  expect(updates[2]).toEqual([{ runtimes: [runtime], external_tools: [] }]);
  expect(cleared).toEqual([runtime]);
  refresher.close();
});

test("revokes a known runtime that lost its route before publication", async () => {
  __testOverrideLoadRoutes(() => null);
  const updates: RuntimeExternalToolsUpdateGroup[][] = [];
  const refresher = createRoutedRuntimeRegistrationRefresher({
    registry: { resolveRoutedTurnSources: () => [] },
    publisher: {
      getKnownRuntimes: () => [runtime],
      publish: async (nextUpdates) => {
        updates.push([...nextUpdates]);
      },
    },
    channelNames: ["slack"],
    buildTool: async (sources) => (sources.length > 0 ? createTool() : null),
  });

  await refresher.refresh();

  expect(updates).toEqual([[{ runtimes: [runtime], external_tools: [] }]]);
  refresher.close();
});

test("preserves proactive tools for known runtimes without routes", async () => {
  __testOverrideLoadRoutes(() => null);
  const updates: RuntimeExternalToolsUpdateGroup[][] = [];
  const refresher = createRoutedRuntimeRegistrationRefresher({
    registry: { resolveRoutedTurnSources: () => [] },
    publisher: {
      getKnownRuntimes: () => [runtime],
      publish: async (nextUpdates) => {
        updates.push([...nextUpdates]);
      },
    },
    channelNames: ["slack"],
    buildTool: async (sources, nextRuntime) =>
      sources.length === 0 && nextRuntime.agent_id === "agent-1"
        ? createTool("Proactive Slack")
        : null,
  });

  await refresher.refresh();

  expect(updates).toEqual([
    [
      {
        runtimes: [runtime],
        external_tools: [{ tools: [createTool("Proactive Slack")] }],
      },
    ],
  ]);
  refresher.close();
});

test("does not expose new route sources until tool publication succeeds", async () => {
  __testOverrideLoadRoutes(() => null);
  let attempts = 0;
  const routedSources: ChannelTurnSource[][] = [];
  const refresher = createRoutedRuntimeRegistrationRefresher({
    registry: { resolveRoutedTurnSources: () => [createSource()] },
    publisher: {
      publish: async (_updates, nextRoutedSources) => {
        attempts++;
        if (attempts === 1) throw new Error("listener unavailable");
        routedSources.push(
          ...nextRoutedSources.map((update) => update.sources),
        );
      },
    },
    channelNames: ["slack"],
    buildTool: async () => createTool(),
  });

  await expect(refresher.refresh()).rejects.toThrow("listener unavailable");
  expect(routedSources).toEqual([]);
  await refresher.refresh();
  expect(routedSources).toEqual([[createSource()]]);
  refresher.close();
});

test("retries a failed background publication until it succeeds", async () => {
  __testOverrideLoadRoutes(() => null);
  let attempts = 0;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const refresher = createRoutedRuntimeRegistrationRefresher({
    registry: { resolveRoutedTurnSources: () => [createSource()] },
    publisher: {
      publish: async () => {
        attempts++;
        if (attempts === 1) throw new Error("temporary failure");
        finish();
      },
    },
    channelNames: ["slack"],
    buildTool: async () => createTool(),
    retryDelayMs: 0,
  });

  refresher.requestRefresh();
  await Promise.race([
    finished,
    Bun.sleep(1000).then(() => {
      throw new Error("registration retry timed out");
    }),
  ]);

  expect(attempts).toBe(2);
  refresher.close();
});

test("runs another publication pass when routes change during refresh", async () => {
  __testOverrideLoadRoutes(() => null);
  let description = "Initial tool";
  let attempts = 0;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let refresher!: ReturnType<typeof createRoutedRuntimeRegistrationRefresher>;
  refresher = createRoutedRuntimeRegistrationRefresher({
    registry: { resolveRoutedTurnSources: () => [createSource()] },
    publisher: {
      publish: async () => {
        attempts++;
        if (attempts === 1) {
          description = "Updated tool";
          refresher.requestRefresh();
        } else {
          finish();
        }
      },
    },
    channelNames: ["slack"],
    buildTool: async () => createTool(description),
  });

  refresher.requestRefresh();
  await Promise.race([
    finished,
    Bun.sleep(1000).then(() => {
      throw new Error("second registration pass timed out");
    }),
  ]);

  expect(attempts).toBe(2);
  refresher.close();
});
