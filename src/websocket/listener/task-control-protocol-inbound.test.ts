import { describe, expect, test } from "bun:test";
import { parseServerMessage } from "./protocol-inbound";
import {
  isMonitorStopCommand,
  isRemoveQueueItemCommand,
} from "./task-control-protocol-inbound";

describe("Monitor stop command parsing", () => {
  const command = {
    type: "monitor_stop" as const,
    request_id: "req",
    process_id: "monitor-a",
    runtime: {
      agent_id: "agent-a",
      conversation_id: "conv-a",
      acting_user_id: "user-a",
    },
  };
  test("preserves runtime and relay actor through the wire parser", () => {
    expect(parseServerMessage(Buffer.from(JSON.stringify(command)))).toEqual(
      command,
    );
    expect(
      isRemoveQueueItemCommand({
        type: "remove_queue_item",
        request_id: "req",
        item_id: "item",
        runtime: command.runtime,
      }),
    ).toBe(true);
  });
  test("rejects missing scope, process identity and request correlation", () => {
    for (const invalid of [
      { ...command, runtime: undefined },
      { ...command, runtime: { agent_id: "agent-a" } },
      { ...command, runtime: { ...command.runtime, acting_user_id: 5 } },
      { ...command, process_id: "" },
      { ...command, request_id: "" },
    ])
      expect(isMonitorStopCommand(invalid)).toBe(false);
  });
});
