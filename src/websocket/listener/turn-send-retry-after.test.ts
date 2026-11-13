import { expect, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { LocalListenerTransport } from "./transport";
import { createTurnInputState } from "./turn-input-state";
import { prepareProviderRetryInput } from "./turn-send";

test("post-stream provider retry waits for the supplied server delay", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-test", "conv-test");
  let releaseSleep: (() => void) | undefined;
  let observedDelay: number | undefined;
  let completed = false;
  const pending = prepareProviderRetryInput({
    input: createTurnInputState([]),
    errorDetail: "Temporary provider rate limit",
    retryAfterMs: 14_000,
    attempt: 1,
    socket: new LocalListenerTransport(),
    runtime,
    turnLease: { signal: new AbortController().signal } as Parameters<
      typeof prepareProviderRetryInput
    >[0]["turnLease"],
    agentId: "agent-test",
    conversationId: "conv-test",
    runId: null,
    sleep: (delayMs) => {
      observedDelay = delayMs;
      return new Promise<void>((resolve) => {
        releaseSleep = resolve;
      });
    },
  }).then(() => {
    completed = true;
  });

  expect(observedDelay).toBe(14_000);
  await Promise.resolve();
  expect(completed).toBe(false);
  releaseSleep?.();
  await pending;
  expect(completed).toBe(true);
});
