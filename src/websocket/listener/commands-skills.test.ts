import { expect, test } from "bun:test";
import type WebSocket from "ws";
import { TestDirectory } from "@/test-utils/test-fs";
import { handleExecuteCommand } from "./commands";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { scheduleQueuePump } from "./queue";
import { setActiveRuntime } from "./runtime";
import type { StartListenerOptions } from "./types";

test("execute_command invokes a manual-only skill as a user turn", async () => {
  const directory = new TestDirectory();
  const previousHome = process.env.HOME;
  process.env.HOME = directory.path;
  const agentId = "agent-skill-command";
  const conversationId = "conv-skill-command";
  directory.createFile(
    ".agents/skills/grill-me/SKILL.md",
    "---\nname: grill-me\ndescription: Ask hard questions\ndisable-model-invocation: true\n---\n\nAsk hard questions.\n",
  );
  const listener = createRuntime();
  listener.bootWorkingDirectory = directory.path;
  listener.agentModAdapters = new Map([
    [
      agentId,
      {
        getSnapshot: () => ({ registry: { commands: {} } }),
      } as NonNullable<typeof listener.modAdapter>,
    ],
  ]);
  const runtime = getOrCreateScopedRuntime(listener, agentId, conversationId);
  runtime.skillSources = ["project"];
  const activeTurn = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: directory.path,
  });
  let releaseActiveTurn!: () => void;
  runtime.messageQueue = new Promise<void>((resolve) => {
    releaseActiveTurn = resolve;
  });
  const sent: string[] = [];
  const socket = { readyState: 1, send: (value: string) => sent.push(value) };
  const processed: string[] = [];
  setActiveRuntime(listener);

  try {
    await handleExecuteCommand(
      {
        type: "execute_command",
        command_id: "grill-me",
        args: "about this spec",
        request_id: "skill-1",
        runtime: {
          agent_id: agentId,
          conversation_id: conversationId,
          acting_user_id: "user-requester",
        },
      },
      socket as unknown as WebSocket,
      runtime,
      {
        connectionId: "skill-connection",
        enqueueSkillMessage: (incoming) => {
          const accepted = enqueueInboundUserMessage(
            runtime,
            incoming,
            "user-requester",
          );
          if (accepted) {
            scheduleQueuePump(
              runtime,
              socket as unknown as WebSocket,
              { connectionId: "skill-connection" } as StartListenerOptions,
              async (queuedTurn) => {
                processed.push(JSON.stringify(queuedTurn.messages));
              },
            );
          }
          return accepted;
        },
      },
    );
    expect(runtime.turnLifecycle.kind).toBe("active");
    expect(runtime.queueRuntime.length).toBe(1);
    expect(processed).toHaveLength(0);
    const incoming = runtime.queuedMessagesByItemId.values().next().value;
    expect(incoming).toMatchObject({
      agentId,
      conversationId,
      actingUserId: "user-requester",
      noCoalesce: true,
      messages: [{ role: "user", content: "/grill-me about this spec" }],
    });
    expect(sent.join("\n")).toContain("slash_command_end");
    expect(JSON.parse(sent[sent.length - 1] ?? "")).toMatchObject({
      success: true,
      output: "",
    });
    runtime.turnLifecycle.finish(activeTurn, "end_turn");
    releaseActiveTurn();
    await runtime.messageQueue;
    expect(processed).toHaveLength(1);
    expect(processed[0]).toContain("/grill-me about this spec");
  } finally {
    if (runtime.turnLifecycle.isCurrent(activeTurn)) {
      runtime.turnLifecycle.finish(activeTurn, "end_turn");
    }
    releaseActiveTurn();
    setActiveRuntime(null);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    directory.cleanup();
  }
});
