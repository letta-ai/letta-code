import { expect, test } from "bun:test";
import {
  createLocalConversationRecord,
  localConversationForkBody,
  updateLocalConversationRecord,
} from "./local-conversation-record";

test("local worker conversations retain lineage and execution settings on update", () => {
  const created = createLocalConversationRecord("local-conv-worker", null, 1, {
    parent_agent_id: "agent-parent",
    is_subagent: true,
    name: "Worker",
    system: "worker prompt",
    model: "openai/gpt-5.5",
    context_window_limit: 64000,
  } as never);
  expect(created).toMatchObject({
    agent_id: null,
    parent_agent_id: "agent-parent",
    is_subagent: true,
    name: "Worker",
    system: "worker prompt",
    model: "openai/gpt-5.5",
  });
  const updated = updateLocalConversationRecord(
    created,
    {
      model: "openai/gpt-5",
      system: "new worker prompt",
    } as never,
    "2026-01-01T00:00:00Z",
  );
  expect(updated).toMatchObject({
    agent_id: null,
    parent_agent_id: "agent-parent",
    system: "new worker prompt",
    model: "openai/gpt-5",
  });
  expect(() =>
    updateLocalConversationRecord(
      updated,
      { model: null } as never,
      "2026-01-02T00:00:00Z",
    ),
  ).toThrow("requires a model");
  expect(localConversationForkBody(updated, null)).toMatchObject({
    parent_agent_id: "agent-parent",
    context_window_limit: 64000,
  });
});
