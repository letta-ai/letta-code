import { expect, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { resolveStaleApprovals } from "./send";

test("approval recovery retries a reset reading resume state and completes", async () => {
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-test",
    "conv-test",
  );
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  let reads = 0;
  let sends = 0;
  const approval = {
    toolCallId: "call-test",
    toolName: "Bash",
    toolArgs: '{"command":"pwd"}',
  };
  const result = await resolveStaleApprovals(
    runtime,
    {
      kind: "local",
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {},
    },
    lease,
    {
      retrieveAgent: async () => {
        if (++reads === 1)
          throw Object.assign(
            new Error(
              "ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
            ),
            { code: "ECONNRESET" },
          );
        return { id: "agent-test" } as never;
      },
      getResumeData: async () => ({
        pendingApproval: approval,
        pendingApprovals: [approval],
        messageHistory: [],
      }),
      prepareToolExecutionContext: async () =>
        ({
          toolset: "codex",
          toolsetPreference: "auto",
          preparedToolContext: {
            contextId: "context-test",
            loadedToolNames: [],
            clientTools: [],
            clientSkills: [],
          },
        }) as never,
      sendApprovalContinuation: async () => {
        sends++;
        return { kind: "stream", stream: {} as never };
      },
      drainRecoveryStream: async () =>
        ({ stopReason: "end_turn", apiDurationMs: 0 }) as never,
    },
  );
  expect(reads).toBe(2);
  expect(sends).toBe(1);
  expect(result?.stopReason).toBe("end_turn");
});
