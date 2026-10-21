import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { __testSetBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { settingsManager } from "@/settings-manager";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { setActiveRuntime } from "./runtime";
import { handleIncomingMessage } from "./turn";

// Exercise the producer: input arrives while the stream owns the turn, then
// the stream returns a call alongside a terminal reason. `end_turn` is the
// listener wire equivalent of provider finish=stop; this does not replay a
// provider response or the external queued-message removal-fallback producer.
for (const stopReason of ["end_turn", "max_steps"] as const) {
  for (const remove of [false, true]) {
    test(`returned calls run before queued input (stop=${stopReason}, removed=${remove})`, async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "listener-queued-approval-"),
      );
      const originalHome = process.env.HOME;
      process.env.HOME = directory;
      await settingsManager.reset();
      const backend = new LocalBackend({
        storageDir: directory,
        executionMode: "deterministic",
        memfsEnabled: false,
      });
      const frames: string[] = [];
      const socket = {
        kind: "local" as const,
        bufferedAmount: 0,
        isOpen: () => true,
        send: (value: string) => {
          frames.push(value);
        },
      };
      // Simulated server approval state: only a submitted tool result clears it.
      const pendingServerCalls = new Set<string>();
      const request = spyOn(backend, "createConversationMessageStream");
      try {
        __testSetBackend(backend);
        await settingsManager.initialize();
        const agent = await backend.createAgent({
          name: "Queue approval",
          model: "anthropic/claude-sonnet-4-6",
        });
        settingsManager.setMemfsEnabled(agent.id, false);
        const conversation = await backend.createConversation({
          agent_id: agent.id,
        });
        const listener = createRuntime();
        setActiveRuntime(listener);
        const runtime = getOrCreateScopedRuntime(
          listener,
          agent.id,
          conversation.id,
        );
        const path = join(directory, "input.txt");
        await writeFile(path, "tool result");
        request.mockImplementationOnce(
          async () =>
            ({
              controller: new AbortController(),
              async *[Symbol.asyncIterator]() {
                enqueueInboundUserMessage(runtime, {
                  type: "message",
                  agentId: agent.id,
                  conversationId: conversation.id,
                  messages: [{ role: "user", content: "queued follow-up" }],
                });
                pendingServerCalls.add("call-read");
                yield {
                  message_type: "approval_request_message",
                  id: "message-read",
                  date: "2026-01-01T00:00:00Z",
                  run_id: "run-read",
                  seq_id: 1,
                  tool_call: {
                    tool_call_id: "call-read",
                    name: "Read",
                    arguments: JSON.stringify({ file_path: path }),
                  },
                };
                if (remove) {
                  const queued = runtime.queueRuntime.peek()[0];
                  if (!queued) throw new Error("Expected queued input");
                  runtime.queueRuntime.removeItem(queued.id);
                }
                yield {
                  message_type: "stop_reason",
                  stop_reason: stopReason,
                  run_id: "run-read",
                  seq_id: 2,
                };
              },
            }) as unknown as Stream<LettaStreamingResponse>,
        );
        request.mockImplementationOnce(async (_conversationId, input) => {
          if (JSON.stringify(input).includes("call-read")) {
            pendingServerCalls.delete("call-read");
          }
          return {
            controller: new AbortController(),
            async *[Symbol.asyncIterator]() {
              yield {
                message_type: "stop_reason",
                stop_reason: "end_turn",
                run_id: "run-complete",
                seq_id: 1,
              };
            },
          } as unknown as Stream<LettaStreamingResponse>;
        });
        await handleIncomingMessage(
          {
            type: "message",
            agentId: agent.id,
            conversationId: conversation.id,
            messages: [{ role: "user", content: "read file" }],
          },
          socket,
          runtime,
        );
        expect({
          classified: frames.some((frame) =>
            frame.includes('"message_type":"approval_classification_end"'),
          ),
          executed: frames.some((frame) =>
            frame.includes('"message_type":"client_tool_end"'),
          ),
          pendingServerCalls: [...pendingServerCalls],
        }).toEqual({
          classified: true,
          executed: true,
          pendingServerCalls: [],
        });
        expect(
          frames.some(
            (frame) =>
              frame.includes('"message_type":"client_tool_end"') &&
              frame.includes('"status":"success"'),
          ),
        ).toBe(true);
        expect(request).toHaveBeenCalledTimes(2);
        const continuation = JSON.stringify(request.mock.calls[1]);
        expect(continuation).toContain("call-read");
        if (!remove) expect(continuation).toContain("queued follow-up");
      } finally {
        request.mockRestore();
        setActiveRuntime(null);
        __testSetBackend(null);
        await settingsManager.reset();
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
