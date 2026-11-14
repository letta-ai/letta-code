import { expect, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { LocalListenerTransport } from "./transport";
import { createTurnInputState } from "./turn-input-state";
import { TurnLifecycle } from "./turn-lifecycle";
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

test("transport cancellation during the retry delay prevents a new send", async () => {
  const lifecycle = new TurnLifecycle(() => "lease-test");
  const lease = lifecycle.begin({
    origin: "message",
    workingDirectory: "/tmp",
  });
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-test", "conv-test");
  let releaseSleep: (() => void) | undefined;
  let sends = 0;
  const retry = prepareProviderRetryInput({
    input: createTurnInputState([]),
    errorDetail: "Temporary provider rate limit",
    retryAfterMs: 14_000,
    attempt: 1,
    socket: new LocalListenerTransport(),
    runtime,
    turnLease: lease,
    agentId: "agent-test",
    conversationId: "conv-test",
    runId: null,
    sleep: () =>
      new Promise<void>((resolve) => {
        releaseSleep = resolve;
      }),
  }).then(() => {
    sends += 1;
  });

  expect(releaseSleep).toBeDefined();
  expect(
    lifecycle.requestCancellation({ cause: "transport" }).transitioned,
  ).toBe(true);
  expect(lease.signal.aborted).toBe(true);
  expect(() =>
    lifecycle.begin({ origin: "message", workingDirectory: "/tmp" }),
  ).toThrow();
  releaseSleep?.();
  await expect(retry).rejects.toThrow("Cancelled by user");
  expect(sends).toBe(0);
});
