import { describe, expect, test } from "bun:test";
import { createChannelTurnProgressBuilder } from "./progress-builder";

describe("channel progress tool input", () => {
  test("exposes complete structured tool input to channel adapters", () => {
    const builder = createChannelTurnProgressBuilder();

    const updates = builder.buildUpdates({
      message_type: "tool_call_message",
      run_id: "run-1",
      tool_calls: [
        {
          tool_call_id: "call-1",
          name: "web_search",
          arguments: JSON.stringify({ query: "Matrix SDK" }),
        },
      ],
    });

    expect(updates[0]?.toolInput).toEqual({ query: "Matrix SDK" });
  });

  test("omits incomplete argument fragments until they form valid JSON", () => {
    const builder = createChannelTurnProgressBuilder();

    const first = builder.buildUpdates({
      message_type: "tool_call_message",
      tool_calls: {
        tool_call_id: "call-1",
        name: "Skill",
        arguments: '{"skill":"custom',
      },
    });
    const second = builder.buildUpdates({
      message_type: "tool_call_message",
      tool_calls: {
        tool_call_id: "call-1",
        arguments: '-adapter"}',
      },
    });

    expect(first[0]?.toolInput).toBeUndefined();
    expect(second[0]?.toolInput).toEqual({ skill: "custom-adapter" });
  });

  test("exposes accumulated input on terminal tool progress", () => {
    const builder = createChannelTurnProgressBuilder();
    builder.buildUpdates({
      message_type: "tool_call_message",
      tool_calls: {
        tool_call_id: "call-1",
        name: "update_plan",
        arguments: '{"plan":[{"step":"Ship",',
      },
    });

    const updates = builder.buildUpdates({
      message_type: "tool_return_message",
      tool_call_id: "call-1",
      name: "update_plan",
      arguments: '"status":"completed"}]}',
      status: "success",
    });

    expect(updates[0]?.toolInput).toEqual({
      plan: [{ step: "Ship", status: "completed" }],
    });
  });
});
