import { expect, test } from "bun:test";
import { createTurnDurabilityOwnership } from "./turn-durability-ownership";

test("multiple generic approval continuations retain every operation", () => {
  const ownership = createTurnDurabilityOwnership();
  ownership.record({
    lastExecutionResults: [
      {
        type: "tool",
        tool_call_id: "call-1",
        status: "success",
        tool_return: "first",
      },
    ],
    lastExecutingToolCallIds: ["call-pending"],
    lastNeedsUserInputToolCallIds: ["call-pending"],
  });

  expect(
    ownership.record({
      lastExecutionResults: [
        {
          type: "tool",
          tool_call_id: "call-pending",
          status: "success",
          tool_return: "second",
        },
      ],
      lastExecutingToolCallIds: ["call-next"],
      lastNeedsUserInputToolCallIds: ["call-next"],
    }),
  ).toEqual({
    lastExecutionResults: [
      {
        type: "tool",
        tool_call_id: "call-1",
        status: "success",
        tool_return: "first",
      },
      {
        type: "tool",
        tool_call_id: "call-pending",
        status: "success",
        tool_return: "second",
      },
    ],
    lastExecutingToolCallIds: ["call-next"],
    lastNeedsUserInputToolCallIds: ["call-next"],
  });
});

test("queued continuation ownership joins the original terminal contract", () => {
  const ownership = createTurnDurabilityOwnership();
  ownership.recordInput({
    durableInputIdentities: [{ domain: "input", id: "original" }],
    terminalConsumerIds: ["slack:original"],
  });
  ownership.recordInput({
    durableInputIdentities: [
      { domain: "input", id: "queued" },
      { domain: "input", id: "original" },
    ],
    terminalConsumerIds: ["slack:queued", "slack:original"],
  });

  expect(ownership.durableInputIdentities).toEqual([
    { domain: "input", id: "original" },
    { domain: "input", id: "queued" },
  ]);
  expect(ownership.terminalConsumerIds).toEqual([
    "slack:original",
    "slack:queued",
  ]);
});
