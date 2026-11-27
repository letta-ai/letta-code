import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import * as repositorySync from "@/agent/attached-repository-git-sync";
import { __testSetBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { settingsManager } from "@/settings-manager";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { handleIncomingMessage } from "./turn";

type StopReason = "llm_api_error" | "requires_approval" | "end_turn";

async function runTurn(stopReasons: StopReason[]) {
  const storageDir = await mkdtemp(join(tmpdir(), "listener-provider-retry-"));
  const path = join(storageDir, "input.txt");
  const backend = new LocalBackend({
    storageDir,
    executionMode: "deterministic",
    memfsEnabled: false,
  });
  const sync = spyOn(
    repositorySync,
    "syncPendingAttachedRepositoryCommitsAfterTurn",
  ).mockResolvedValue({ results: [] });
  let nextAttempt = 0;
  const request = spyOn(
    backend,
    "createConversationMessageStream",
  ).mockImplementation(async () => {
    const attempt = nextAttempt++;
    const stopReason = stopReasons[attempt];
    if (!stopReason) throw new Error("Unexpected additional request");
    const runId = `run-${attempt}`;
    return {
      controller: new AbortController(),
      async *[Symbol.asyncIterator]() {
        if (stopReason === "requires_approval") {
          yield {
            run_id: runId,
            seq_id: 1,
            message_type: "approval_request_message",
            id: `message-${attempt}`,
            date: "2026-10-20T00:00:00Z",
            tool_call: {
              tool_call_id: `call-${attempt}`,
              name: "Read",
              arguments: JSON.stringify({ file_path: path }),
            },
          };
        }
        yield {
          run_id: runId,
          seq_id: 2,
          message_type: "stop_reason",
          stop_reason: stopReason,
        };
      },
    } as unknown as Stream<LettaStreamingResponse>;
  });

  try {
    await writeFile(path, "file contents");
    __testSetBackend(backend);
    await settingsManager.initialize();
    const agent = await backend.createAgent({
      name: "Provider retry",
      model: "anthropic/claude-sonnet-4-6",
    });
    settingsManager.setMemfsEnabled(agent.id, false);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    });
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      agent.id,
      conversation.id,
    );
    await handleIncomingMessage(
      {
        type: "message",
        agentId: agent.id,
        conversationId: conversation.id,
        messages: [{ role: "user", content: "Read the file." }],
      },
      {
        kind: "local",
        bufferedAmount: 0,
        isOpen: () => true,
        send: () => {},
      },
      runtime,
    );
    return {
      stopReason: runtime.lastStopReason,
      attempts: request.mock.calls.length,
    };
  } finally {
    request.mockRestore();
    sync.mockRestore();
    __testSetBackend(null);
    await rm(storageDir, { recursive: true, force: true });
  }
}

test("a successful approval step renews the provider retry budget", async () => {
  expect(
    await runTurn([
      "llm_api_error",
      "requires_approval",
      "llm_api_error",
      "requires_approval",
      "llm_api_error",
      "requires_approval",
      "llm_api_error",
      "end_turn",
    ]),
  ).toEqual({ stopReason: "end_turn", attempts: 8 });
}, 30_000);

test("four consecutive provider failures end the step after three retries", async () => {
  expect(
    await runTurn([
      "llm_api_error",
      "llm_api_error",
      "llm_api_error",
      "llm_api_error",
      "end_turn",
    ]),
  ).toEqual({ stopReason: "llm_api_error", attempts: 4 });
}, 30_000);
