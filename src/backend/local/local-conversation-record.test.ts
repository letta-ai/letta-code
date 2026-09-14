import { expect, test } from "bun:test";
import {
  createLocalConversationRecord,
  updateLocalConversationRecord,
} from "./local-conversation-record";

test("names and subagent metadata remain independent of the conversation summary", () => {
  const original = createLocalConversationRecord(
    "conv-child",
    "agent-parent",
    1,
    {
      name: "Joi (subagent)",
      is_subagent: true,
      summary: "Investigate logs",
    } as never,
  );
  expect(original).toMatchObject({
    agent_id: "agent-parent",
    name: "Joi (subagent)",
    is_subagent: true,
    summary: "Investigate logs",
  });
  const updated = updateLocalConversationRecord(
    original,
    { name: "Ava", summary: "Report ready" } as never,
    "2026-09-14T20:00:00Z",
  );
  expect(updated).toMatchObject({
    name: "Ava",
    is_subagent: true,
    summary: "Report ready",
  });
  expect(original.name).toBe("Joi (subagent)");
  expect(
    updateLocalConversationRecord(
      updated,
      { name: null, is_subagent: false } as never,
      "2026-09-14T20:00:00Z",
    ),
  ).toMatchObject({ name: null, is_subagent: false });
});
