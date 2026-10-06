import { expect, test } from "bun:test";
import {
  RECOVERED_APPROVAL_OUTCOME_UNKNOWN,
  recoveredApprovalInFlightResults,
} from "./recovered-approval-checkpoint";

test("hard-death checkpoint distinguishes unknown execution from denial", () => {
  const approval = {
    toolCallId: "call-approved",
    toolName: "Bash",
    toolArgs: '{"command":"deploy"}',
  };
  expect(
    recoveredApprovalInFlightResults([
      { type: "approve", approval },
      {
        type: "deny",
        approval: { ...approval, toolCallId: "call-denied" },
        reason: "policy",
      },
    ]),
  ).toEqual([
    {
      type: "tool",
      tool_call_id: "call-approved",
      status: "error",
      tool_return: RECOVERED_APPROVAL_OUTCOME_UNKNOWN,
    },
    {
      type: "approval",
      tool_call_id: "call-denied",
      approve: false,
      reason: "policy",
    },
  ]);
});
