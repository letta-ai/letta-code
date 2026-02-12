import { describe, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { createBuffers } from "../../cli/helpers/accumulator";
import { backfillBuffers } from "../../cli/helpers/backfill";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../../constants";

function userMessage(
  id: string,
  content: string | Array<{ type: "text"; text: string }>,
): Message {
  return {
    id,
    message_type: "user_message",
    content,
  } as unknown as Message;
}

describe("backfill system-reminder handling", () => {
  test("hides pure system-reminder content parts", () => {
    const buffers = createBuffers();
    const history = [
      userMessage("u1", [
        {
          type: "text",
          text: `${SYSTEM_REMINDER_OPEN}\nInjected context\n${SYSTEM_REMINDER_CLOSE}`,
        },
        { type: "text", text: "Real user message" },
      ]),
    ];

    backfillBuffers(buffers, history);

    const line = buffers.byId.get("u1");
    expect(line?.kind).toBe("user");
    expect(line && "text" in line ? line.text : "").toBe("Real user message");
  });

  test("removes system-reminder blocks from string content while preserving user text", () => {
    const buffers = createBuffers();
    const history = [
      userMessage(
        "u2",
        `${SYSTEM_REMINDER_OPEN}\nInjected context\n${SYSTEM_REMINDER_CLOSE}\n\nKeep this text`,
      ),
    ];

    backfillBuffers(buffers, history);

    const line = buffers.byId.get("u2");
    expect(line?.kind).toBe("user");
    expect(line && "text" in line ? line.text : "").toBe("Keep this text");
  });

  test("drops user rows that are only system-reminder content", () => {
    const buffers = createBuffers();
    const history = [
      userMessage(
        "u3",
        `${SYSTEM_REMINDER_OPEN}\nInjected context\n${SYSTEM_REMINDER_CLOSE}`,
      ),
    ];

    backfillBuffers(buffers, history);

    expect(buffers.byId.get("u3")).toBeUndefined();
    expect(buffers.order).toHaveLength(0);
  });
});
