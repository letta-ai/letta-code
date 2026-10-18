import { expect, test } from "bun:test";
import { ApiRequestError } from "@/backend/api/request";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { recoveryRefusalPolicy } from "./recovery-refusal-policy";

test("owner mismatch backs off, stops after five refusals, and resets on reconnect", async () => {
  const listener = createRuntime();
  listener.connectionId = "conn-test";
  listener.connectionGeneration = "first";
  const record = { agentId: "agent-1", conversationId: "conv-1" };
  const runtime = getOrCreateScopedRuntime(
    listener,
    record.agentId,
    record.conversationId,
  );
  let now = 0;
  let requests = 0;
  const request = async () => {
    requests++;
    throw new ApiRequestError("refused", 409, '{"detail":"owner_mismatch"}');
  };
  const policy = () =>
    recoveryRefusalPolicy(listener, record, undefined, () => now);
  for (const delay of [5000, 10000, 20000, 40000, Infinity]) {
    expect(policy().ready).toBe(true);
    expect(await policy().acquire(runtime, undefined, { request })).toBeNull();
    expect(policy().delay(5000)).toBe(delay);
    expect(policy().ready).toBe(false);
    if (Number.isFinite(delay)) now += delay;
  }
  now += 1_000_000;
  expect(policy().ready).toBe(false);
  expect(requests).toBe(5);
  listener.connectionGeneration = "second";
  expect(policy().ready).toBe(true);
  await policy().acquire(runtime, undefined, { request });
  expect(policy().delay(5000)).toBe(5000);
  now += 5000;
  await policy().acquire(runtime, undefined, {
    request: async () => {
      throw new ApiRequestError("unavailable", 503, "{}");
    },
  });
  expect(policy().delay(5000)).toBe(5000);
  await policy().acquire(runtime, undefined, { request });
  expect(policy().delay(5000)).toBe(5000);
});
