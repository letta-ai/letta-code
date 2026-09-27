import { expect, test } from "bun:test";
import {
  lifecycleOutcome,
  runIdFromDelta,
  stopReasonFromDelta,
} from "./gateway-terminal";
import { makeStreamDelta } from "./gateway-test-support";

test("terminal classification remains independent of subagent notices", () => {
  expect(lifecycleOutcome("end_turn")).toBe("completed");
  expect(lifecycleOutcome("tool_rule")).toBe("completed");
  expect(lifecycleOutcome("cancelled")).toBe("cancelled");
  expect(lifecycleOutcome("error")).toBe("error");
  const stop = makeStreamDelta({
    message_type: "stop_reason",
    stop_reason: "end_turn",
    run_id: "run-1",
  });
  expect(stopReasonFromDelta(stop)).toBe("end_turn");
  expect(runIdFromDelta(stop)).toBe("run-1");
  const other = makeStreamDelta({ message_type: "assistant_message" });
  expect(stopReasonFromDelta(other)).toBeNull();
  expect(runIdFromDelta(other)).toBeUndefined();
});
