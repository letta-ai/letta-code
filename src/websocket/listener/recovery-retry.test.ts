import { expect, test } from "bun:test";
import { ApiRequestError } from "@/backend/api/request";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { acquireRecoveryClaim, recoveryRetryDelay } from "./recovery-ownership";

test("owner mismatch backs off, stops after five refused passes, and resets", async () => {
  const listener = createRuntime();
  listener.connectionId = "conn-test";
  listener.connectionGeneration = "first";
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const refuse = () =>
    acquireRecoveryClaim(runtime, undefined, {
      request: async () => {
        throw new ApiRequestError(
          "refused",
          409,
          '{"detail":"owner_mismatch"}',
        );
      },
    });
  for (const delay of [5000, 10000, 20000, 40000, Infinity]) {
    expect(await refuse()).toBeNull();
    // Multiple acquisitions in one pass count as one refused pass.
    expect(await refuse()).toBeNull();
    expect(recoveryRetryDelay(listener, 5000)).toBe(delay);
  }
  listener.connectionGeneration = "second";
  expect(recoveryRetryDelay(listener, 5000)).toBe(5000);
  await refuse();
  expect(recoveryRetryDelay(listener, 5000)).toBe(5000);
  await acquireRecoveryClaim(runtime, undefined, {
    request: async () => {
      throw new ApiRequestError("unavailable", 503, "{}");
    },
  });
  expect(recoveryRetryDelay(listener, 5000)).toBe(5000);
  const claim = await acquireRecoveryClaim(runtime, undefined, {
    request: async () => ({
      token: "test",
      fence: 1,
      expires_at: Date.now() + 15000,
    }),
    schedule: () => undefined,
  });
  expect(claim).not.toBeNull();
  claim?.abandon();
  await refuse();
  expect(recoveryRetryDelay(listener, 5000)).toBe(5000);
});
