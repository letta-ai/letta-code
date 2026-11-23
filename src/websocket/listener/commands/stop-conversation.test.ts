import { expect, spyOn, test } from "bun:test";
import { getBackend } from "@/backend";
import type { SubagentStopCommand } from "@/types/subagent-protocol";
import { stopListenerConversation } from "./stop-conversation";

const command: SubagentStopCommand = {
  type: "subagent_stop",
  request_id: "stop-child",
  runtime: { agent_id: "agent-child", conversation_id: "conv-child" },
  agent_id: "agent-child",
  conversation: { agent_id: "agent-child", conversation_id: "conv-child" },
};

test("does not acknowledge until the turn abort and schedule deletion are confirmed", async () => {
  let finishAbort!: () => void;
  let finishWakes!: () => void;
  const aborting = new Promise<void>((resolve) => {
    finishAbort = resolve;
  });
  const deleting = new Promise<void>((resolve) => {
    finishWakes = resolve;
  });
  let wakesStarted = false;
  let settled = false;
  const result = stopListenerConversation(
    command,
    async () => {
      await aborting;
      return true;
    },
    {
      cancelWakes: async (scope) => {
        expect(scope).toEqual({
          agentId: "agent-child",
          conversationId: "conv-child",
        });
        wakesStarted = true;
        await deleting;
      },
    },
  ).then((response) => {
    settled = true;
    return response;
  });
  await Bun.sleep(0);
  expect(wakesStarted).toBe(false);
  expect(settled).toBe(false);
  finishAbort();
  await Bun.sleep(0);
  expect(wakesStarted).toBe(true);
  expect(settled).toBe(false);
  finishWakes();
  expect(await result).toMatchObject({ success: true, stopped: true });
});

test("a failed backend cancel cannot produce stopped:true", async () => {
  const cancel = spyOn(getBackend(), "cancelConversation").mockResolvedValue({
    "run-child": "failed",
  });
  try {
    const response = await stopListenerConversation(
      command,
      async () => false,
      {
        cancelWakes: async () => {},
      },
    );
    expect(response).toMatchObject({ success: false, stopped: false });
  } finally {
    cancel.mockRestore();
  }
});

test("a schedule deletion failure cannot produce stopped:true", async () => {
  const response = await stopListenerConversation(command, async () => true, {
    cancelWakes: async () => {
      throw new Error("Schedule deletion failed");
    },
  });
  expect(response).toMatchObject({
    success: false,
    stopped: false,
    error: "Schedule deletion failed",
  });
});

test("a stop cannot clean another conversation through its control scope", async () => {
  let aborted = false;
  const response = await stopListenerConversation(
    {
      ...command,
      conversation: { agent_id: "agent-child", conversation_id: "conv-other" },
    },
    async () => {
      aborted = true;
      return true;
    },
  );
  expect(response).toMatchObject({ success: false, stopped: false });
  expect(aborted).toBe(false);
});
