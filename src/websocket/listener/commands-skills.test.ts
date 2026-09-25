import { expect, spyOn, test } from "bun:test";
import type WebSocket from "ws";
import { TestDirectory } from "@/test-utils/test-fs";
import { __listenClientTestUtils } from "./client";
import { handleExecuteCommand } from "./commands";
import * as turnModule from "./turn";

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
  const listener = __listenClientTestUtils.createListenerRuntime();
  listener.bootWorkingDirectory = directory.path;
  listener.agentModAdapters = new Map([
    [
      agentId,
      {
        getSnapshot: () => ({ registry: { commands: {} } }),
      } as NonNullable<typeof listener.modAdapter>,
    ],
  ]);
  const runtime = __listenClientTestUtils.getOrCreateConversationRuntime(
    listener,
    agentId,
    conversationId,
  );
  runtime.skillSources = ["project"];
  const turn = spyOn(turnModule, "handleIncomingMessage").mockResolvedValue();
  const sent: string[] = [];
  const socket = { readyState: 1, send: (value: string) => sent.push(value) };

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
      { connectionId: "skill-connection" },
    );
    expect(turn).toHaveBeenCalledTimes(1);
    const incoming = turn.mock.calls[0]?.[0];
    expect(incoming).toMatchObject({
      agentId,
      conversationId,
      actingUserId: "user-requester",
    });
    expect(JSON.stringify(incoming?.messages)).toContain(
      '<skill_content name=\\"grill-me\\">',
    );
    expect(JSON.stringify(incoming?.messages)).toContain("about this spec");
    expect(sent.join("\n")).toContain("slash_command_end");
    expect(JSON.parse(sent[sent.length - 1] ?? "")).toMatchObject({
      success: true,
      output: "",
    });
  } finally {
    turn.mockRestore();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    directory.cleanup();
  }
});
