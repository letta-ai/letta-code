import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  sendAgentMessageFixture,
  TARGET_CONV,
} from "@/test-utils/send-agent-message-fixture";
import { isolateAmbientLettaTestEnv } from "@/test-utils/test-process-env";
import { send_agent_message } from "./send-agent-message";

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = isolateAmbientLettaTestEnv();
});
afterEach(() => restoreEnv());

const conversationId = "conv-11111111-1111-4111-8111-111111111111";

test.each([null, conversationId])(
  "agentless sender %s can reply to its parent without destination IDs",
  async (agentId) => {
    const f = sendAgentMessageFixture();
    const lookup = spyOn(f.backend, "retrieveConversation").mockResolvedValue({
      id: conversationId,
      agent_id: null,
      is_subagent: true,
      parent_agent_id: "agent-parent",
      parent_conversation_id: TARGET_CONV,
    } as never);
    try {
      const result = await runWithRuntimeContext(
        { agentId, conversationId },
        () => send_agent_message({ message: "Finished the follow-up." }, f),
      );
      expect(result.status).toBe("success");
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(f.submissions).toHaveLength(1);
      expect(f.submissions[0]?.conversationId).toBe(TARGET_CONV);
      expect(f.submissions[0]?.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining(
            `This message is from agent agent-parent, conversation ${conversationId}.`,
          ),
        },
        { type: "text", text: "Finished the follow-up." },
      ]);
    } finally {
      lookup.mockRestore();
    }
  },
);

test("headless ephemeral sender resolves its parent agent before address validation", async () => {
  const f = sendAgentMessageFixture();
  const lookup = spyOn(f.backend, "retrieveConversation");
  const previous = { ...process.env };
  try {
    process.env.LETTA_CODE_AGENT_ROLE = "subagent";
    process.env.LETTA_PARENT_AGENT_ID = "agent-parent";
    process.env.LETTA_PARENT_CONVERSATION_ID = TARGET_CONV;
    process.env.LETTA_SUBAGENT_DEPTH = "1";
    const result = await runWithRuntimeContext(
      { agentId: conversationId, conversationId },
      () =>
        send_agent_message(
          { message: "Done", conversation_id: TARGET_CONV },
          f,
        ),
    );
    expect(result.status).toBe("success");
    expect(lookup).not.toHaveBeenCalled();
    expect(f.submissions[0]?.content).toEqual(
      expect.arrayContaining([
        {
          type: "text",
          text: expect.stringContaining(
            `agent agent-parent, conversation ${conversationId}`,
          ),
        },
      ]),
    );
  } finally {
    process.env = previous;
    lookup.mockRestore();
  }
});
