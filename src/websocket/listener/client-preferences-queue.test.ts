import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsManager } from "@/settings-manager";
import {
  getStoredClientPreferences,
  replaceClientPreferences,
} from "@/tools/client-preferences";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { parseServerMessage } from "./protocol-inbound";
import { consumeQueuedTurn } from "./queue";
import type { IncomingMessage } from "./types";

const originalHome = process.env.HOME;
let testHomeDir: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(
    join(tmpdir(), "letta-client-preferences-queue-"),
  );
  process.env.HOME = testHomeDir;
  await settingsManager.initialize();
});

afterEach(async () => {
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function parsePreferences(
  kind: "create_message" | "teleport_continue",
  preferences: unknown,
) {
  return parseServerMessage(
    Buffer.from(
      JSON.stringify({
        type: "input",
        runtime: { agent_id: "agent-a", conversation_id: "conv-a" },
        payload: {
          ...(kind === "create_message"
            ? { kind, messages: [{ role: "user", content: "hello" }] }
            : {
                kind,
                teleport_id: "teleport-1",
                source: { device_id: "device-1", connection_name: "Laptop" },
              }),
          client_preferences: preferences,
        },
      }),
    ),
  );
}

describe("client preferences wire protocol", () => {
  for (const kind of ["create_message", "teleport_continue"] as const) {
    test(`${kind} accepts snapshots, aliases, explicit clear, and omission`, () => {
      for (const preferences of [
        undefined,
        {},
        { toolset: { include: [] } },
        { toolset: { include: ["AskUserQuestion", "Task", "Agent", "Read"] } },
      ]) {
        const parsed = parsePreferences(kind, preferences);
        expect(parsed).toMatchObject({ type: "input", payload: { kind } });
        if (preferences !== undefined) {
          expect(parsed).toMatchObject({
            payload: { client_preferences: preferences },
          });
        }
      }
    });

    test(`${kind} rejects invalid preference objects and unknown tools`, () => {
      for (const preferences of [
        null,
        [],
        { unknown: true },
        { toolset: { include: ["Read"], exclude: ["Bash"] } },
        { toolset: { include: ["unknown-client-tool"] } },
        { toolset: { include: [false] } },
        { toolset: { include: "Read" } },
        { toolset: {} },
      ]) {
        expect(parsePreferences(kind, preferences)).toMatchObject({
          type: "__invalid_input",
        });
      }
    });
  }
});

function message(
  id: string,
  selection: Partial<IncomingMessage> = {},
): IncomingMessage {
  return {
    type: "message",
    agentId: "agent-a",
    conversationId: "conv-a",
    messages: [{ role: "user", content: id, client_message_id: id }],
    ...selection,
  };
}

const selections: Partial<IncomingMessage>[] = [
  { clientPreferences: { toolset: { include: ["Read"] } } },
  { clientPreferences: {} },
  { clientPreferences: { toolset: { include: [] } } },
];

describe("client preference queue boundaries", () => {
  test.each(selections)(
    "changed selection %j starts a batch whose omitted inputs inherit it",
    (selection) => {
      replaceClientPreferences("agent-a", "conv-a", {
        toolset: { include: ["Bash"] },
      });
      const runtime = getOrCreateScopedRuntime(
        createRuntime(),
        "agent-a",
        "conv-a",
      );
      for (const incoming of [
        message("before"),
        message("selection", selection),
        message("after"),
      ]) {
        expect(enqueueInboundUserMessage(runtime, incoming)).toBe(true);
      }
      expect(consumeQueuedTurn(runtime)?.dequeuedBatch.items).toHaveLength(1);
      const changed = consumeQueuedTurn(runtime);
      expect(changed?.dequeuedBatch.items).toHaveLength(2);
      expect(changed?.queuedTurn).toMatchObject(selection);
      expect(consumeQueuedTurn(runtime)).toBeNull();
    },
  );

  test.each(selections)(
    "explicit selection %j waits for idle instead of steering an active turn",
    (selection) => {
      replaceClientPreferences("agent-a", "conv-a", {
        toolset: { include: ["Bash"] },
      });
      const runtime = getOrCreateScopedRuntime(
        createRuntime(),
        "agent-a",
        "conv-a",
      );
      const lease = runtime.turnLifecycle.begin({
        origin: "message",
        workingDirectory: process.cwd(),
      });
      enqueueInboundUserMessage(runtime, message("steering"));
      enqueueInboundUserMessage(runtime, message("selection", selection));
      enqueueInboundUserMessage(runtime, message("after"));
      const steering = consumeQueuedTurn(runtime);
      expect(steering?.dequeuedBatch.items).toHaveLength(1);
      expect(steering?.queuedTurn.messages[0]).toMatchObject({
        content: "steering",
      });
      expect(consumeQueuedTurn(runtime)).toBeNull();
      expect(runtime.queueRuntime.length).toBe(2);
      expect(runtime.queuedMessagesByItemId.size).toBe(2);
      runtime.turnLifecycle.finish(lease, "end_turn");
      const selected = consumeQueuedTurn(runtime);
      expect(selected?.dequeuedBatch.items).toHaveLength(2);
      expect(selected?.queuedTurn).toMatchObject(selection);
      expect(consumeQueuedTurn(runtime)).toBeNull();
    },
  );

  test("omitted preferences leave ordinary messages coalescable", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-a",
      "conv-a",
    );
    enqueueInboundUserMessage(runtime, message("first"));
    enqueueInboundUserMessage(runtime, message("second"));
    expect(consumeQueuedTurn(runtime)?.dequeuedBatch.items).toHaveLength(2);
    expect(consumeQueuedTurn(runtime)).toBeNull();
  });

  test("identical normalized UI snapshots steer an active turn and coalesce without writes", () => {
    const preferences = { toolset: { include: ["AskUserQuestion"] } };
    replaceClientPreferences("agent-a", "conv-a", preferences);
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-a",
      "conv-a",
    );
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    const update = spyOn(settingsManager, "updateSettings");
    try {
      enqueueInboundUserMessage(
        runtime,
        message("answer", { clientPreferences: preferences }),
      );
      enqueueInboundUserMessage(
        runtime,
        message("more", {
          clientPreferences: {
            toolset: { include: ["AskUserQuestionAsync", "AskUserQuestion"] },
          },
        }),
      );
      enqueueInboundUserMessage(
        runtime,
        message("changed", { clientPreferences: {} }),
      );
      expect(consumeQueuedTurn(runtime)?.dequeuedBatch.items).toHaveLength(2);
      expect(consumeQueuedTurn(runtime)).toBeNull();
      expect(update).not.toHaveBeenCalled();
    } finally {
      update.mockRestore();
      runtime.turnLifecycle.finish(lease, "end_turn");
    }
  });

  test("request-only client_toolset retains its existing active steering behavior", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-a",
      "conv-a",
    );
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    enqueueInboundUserMessage(
      runtime,
      message("request", { clientToolset: { include: ["Read"] } }),
    );
    expect(consumeQueuedTurn(runtime)?.queuedTurn.clientToolset).toEqual({
      include: ["Read"],
    });
    runtime.turnLifecycle.finish(lease, "end_turn");
  });

  test("enqueue does not replace or clear the stored snapshot before turn setup", () => {
    const stored = { toolset: { include: ["Bash"] } };
    replaceClientPreferences("agent-a", "conv-a", stored);
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-a",
      "conv-a",
    );
    const update = spyOn(settingsManager, "updateSettings");
    try {
      for (const [index, selection] of selections.entries()) {
        expect(
          enqueueInboundUserMessage(
            runtime,
            message(`queued-${index}`, selection),
          ),
        ).toBe(true);
        expect(getStoredClientPreferences("agent-a", "conv-a")).toEqual(stored);
      }
      expect(update).not.toHaveBeenCalled();
      expect(runtime.queueRuntime.length).toBe(selections.length);
    } finally {
      update.mockRestore();
    }
  });
});
