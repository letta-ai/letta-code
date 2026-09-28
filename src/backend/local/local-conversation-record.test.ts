import { expect, test } from "bun:test";
import {
  createLocalConversationRecord,
  updateLocalConversationRecord,
} from "./local-conversation-record";

test("detached records retain prompt and lineage when updated", () => {
  const original = createLocalConversationRecord("local-conv-test", null, {
    system: "original system",
    parent_agent_id: "agent-parent",
    model: "openai/gpt-5.6-luna",
  } as never);
  expect(original.agent_id).toBeNull();
  const updated = updateLocalConversationRecord(
    original,
    {
      summary: "renamed",
    } as never,
    "2026-01-01T00:00:00.000Z",
  );
  expect(updated).toMatchObject({
    agent_id: null,
    parent_agent_id: "agent-parent",
    system: "original system",
    summary: "renamed",
  });
  expect(original.summary).toBeNull();
});
