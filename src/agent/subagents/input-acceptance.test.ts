import { expect, test } from "bun:test";
import {
  createSubagentInputObserver,
  emitSubagentInputAccepted,
  SUBAGENT_INITIAL_INPUT_ENV,
  subagentInitialInputId,
} from "./input-acceptance";

const receipt = {
  status: "queued" as const,
  agent_id: "agent-1",
  conversation_id: "conv-1",
  client_message_id: "task-initial:conv-1",
  workflow_id: "conv-queue-conv-1",
  super_run_id: "super-1",
};
const env = {
  [SUBAGENT_INITIAL_INPUT_ENV]: JSON.stringify({
    conversationId: "conv-1",
    clientMessageId: receipt.client_message_id,
  }),
};

test("only the prepared conversation reuses the initial ID across retries", () => {
  expect(subagentInitialInputId("conv-1", "random-1", env)).toBe(
    receipt.client_message_id,
  );
  expect(subagentInitialInputId("conv-1", "random-2", env)).toBe(
    receipt.client_message_id,
  );
  expect(subagentInitialInputId("conv-other", "random-3", env)).toBe(
    "random-3",
  );
  expect(subagentInitialInputId("conv-1", "random-4", {})).toBe("random-4");
});

test("reports actual acceptance only for the opt-in initial input", async () => {
  const frames: string[] = [];
  const write = async (text: string) => {
    frames.push(text);
  };
  await emitSubagentInputAccepted(receipt, {}, write);
  await emitSubagentInputAccepted(
    { ...receipt, client_message_id: "other" },
    env,
    write,
  );
  expect(frames).toHaveLength(0);
  await emitSubagentInputAccepted(receipt, env, write);
  const frame = frames[0];
  if (!frame) throw new Error("No acceptance frame was emitted");
  expect(JSON.parse(frame)).toEqual({
    type: "system",
    subtype: "input_accepted",
    receipt,
  });
});

test("acceptance callback runs once even when the child also emits a final queued result", async () => {
  let count = 0;
  const observer = createSubagentInputObserver({
    clientMessageId: receipt.client_message_id,
    onInputAccepted: async () => {
      count++;
    },
  });
  observer.observe(undefined);
  expect(count).toBe(0);
  observer.observe(receipt);
  observer.observe(receipt);
  await observer.finish();
  expect(count).toBe(1);
});
