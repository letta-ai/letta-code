import { expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import {
  setConversationId,
  setCurrentAgentId,
  setCurrentAgentName,
} from "@/agent/context";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { settingsManager } from "@/settings-manager";
import { TestDirectory } from "@/test-utils/test-fs";
import { isolateAmbientLettaTestEnv } from "@/test-utils/test-process-env";
import { clearCapturedToolExecutionContexts } from "@/tools/manager";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { LISTENER_STREAM_RESUME_POLICY } from "./constants";
import { handleAbortMessageInput } from "./control-inputs";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import {
  __listenerModAdapterTestUtils,
  createListenerModAdapter,
  disposeListenerModAdapter,
} from "./mod-adapter";
import { getOrCreateConversationPermissionModeStateRef } from "./permission-mode";
import { setActiveRuntime } from "./runtime";
import { handleIncomingMessage } from "./turn";
import type { StartListenerOptions } from "./types";
import { __listenerWarmupTestUtils } from "./warmup";

function stream(
  chunks: LettaStreamingResponse[],
): Stream<LettaStreamingResponse> {
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

for (const closeKind of [
  "eof",
  "client_abort",
  "network_error",
  "retry",
  "exhausted",
  "interrupt",
] as const) {
  const interrupt = closeKind === "interrupt";
  test(`${closeKind}: early POST close executes the resumed tool or cancels explicitly`, async () => {
    const directory = new TestDirectory();
    const originalHome = process.env.HOME;
    await settingsManager.reset();
    const restoreEnv = isolateAmbientLettaTestEnv();
    process.env.HOME = directory.path;
    const agentId = "agent-early-close";
    const conversationId = "default";
    const output = `${directory.path}/resumed.txt`;
    let turns = 0;
    const backend = new FakeHeadlessBackend(
      agentId,
      {
        async execute() {
          turns++;
          return stream(
            turns === 1
              ? [
                  { message_type: "ping" } as LettaStreamingResponse,
                  {
                    message_type: "approval_request_message",
                    tool_call: {
                      tool_call_id: "call-early-close",
                      name: "ApplyPatch",
                      arguments: JSON.stringify({
                        input: `*** Begin Patch\n*** Add File: ${output}\n+resumed\n*** End Patch`,
                      }),
                    },
                  } as LettaStreamingResponse,
                  {
                    message_type: "stop_reason",
                    stop_reason: "requires_approval",
                  } as LettaStreamingResponse,
                ]
              : [
                  {
                    message_type: "assistant_message",
                    id: "message-completed",
                    content: "Finished",
                  } as LettaStreamingResponse,
                  {
                    message_type: "stop_reason",
                    stop_reason: "end_turn",
                  } as LettaStreamingResponse,
                ],
          );
        },
      },
      { storageDir: directory.createDir("backend") },
      { modelHandle: "anthropic/claude-sonnet-4-6" },
    );
    __testSetBackend(backend);
    __listenerWarmupTestUtils.setWarmupDepsForTests({
      ensureMemfsSyncedForAgent: async () => false,
      ensureSecretsHydratedForAgent: async () => {},
    });
    __listenerModAdapterTestUtils.setEnsureMemfsSyncedForAgentForTests(
      async () => false,
    );
    const listener = createRuntime();
    listener.bootWorkingDirectory = directory.path;
    listener.modAdapter = createListenerModAdapter({
      globalModsDirectory: directory.createDir("mods"),
      cacheDirectory: directory.createDir("cache"),
    });
    const sent: string[] = [];
    const socket = {
      kind: "local" as const,
      bufferedAmount: 0,
      isOpen: () => true,
      send: (data: string) => {
        sent.push(data);
      },
    };
    const options: StartListenerOptions = {
      connectionId: "connection-early-close",
      wsUrl: "local://test",
      deviceId: "device-test",
      connectionName: "Test",
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    };
    openListenerConnection({
      runtime: listener,
      connectionId: options.connectionId,
      writer: socket,
      options,
    });
    markListenerConnectionInitialized(listener, options.connectionId);
    subscribeListenerConnection(listener, options.connectionId, {
      agent_id: agentId,
      conversation_id: conversationId,
    });
    setActiveRuntime(listener);
    const runtime = getOrCreateScopedRuntime(listener, agentId, conversationId);
    runtime.skillSources = [];
    getOrCreateConversationPermissionModeStateRef(
      listener,
      agentId,
      conversationId,
    ).mode = "unrestricted";
    const originalCreate =
      backend.createConversationMessageStream.bind(backend);
    let firstRunId: string | undefined;
    let backgroundCompletion: Promise<void> | undefined;
    const create = spyOn(
      backend,
      "createConversationMessageStream",
    ).mockImplementation(async (...args) => {
      const original = await originalCreate(...args);
      if (firstRunId) return original;
      // The background producer owns the remaining chunks independently of HTTP.
      const iterator = original[Symbol.asyncIterator]();
      const initial = await iterator.next();
      if (initial.done) throw new Error("Missing initial ping");
      const first = initial.value;
      firstRunId = (first as { run_id: string }).run_id;
      const finishBackgroundRun = async () => {
        while (!(await iterator.next()).done) {
          // Persist the producer's tail without delivering it over the POST stream.
        }
      };
      if (interrupt) await finishBackgroundRun();
      const controller = new AbortController();
      return {
        controller,
        async *[Symbol.asyncIterator]() {
          yield first;
          if (!interrupt) backgroundCompletion = finishBackgroundRun();
          if (interrupt) {
            await new Promise<void>((resolve) => {
              if (controller.signal.aborted) resolve();
              else
                controller.signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
            });
          } else if (closeKind === "client_abort") {
            // The SDK swallows a controller-triggered AbortError and ends iteration.
            controller.abort();
          } else if (closeKind === "network_error") {
            throw new Error("Connection closed before terminal event");
          }
        },
      } as unknown as Stream<LettaStreamingResponse>;
    });
    const originalResume = backend.streamRunMessages.bind(backend);
    let resumeAttempts = 0;
    const resume = spyOn(backend, "streamRunMessages").mockImplementation(
      async (...args) => {
        await backgroundCompletion;
        resumeAttempts++;
        if (
          closeKind === "exhausted" ||
          (closeKind === "retry" && resumeAttempts === 1)
        ) {
          throw new Error("Run stream unavailable");
        }
        return originalResume(...args);
      },
    );
    const savedPolicy = { ...LISTENER_STREAM_RESUME_POLICY };
    if (closeKind === "exhausted") {
      Object.assign(LISTENER_STREAM_RESUME_POLICY, {
        maxAttempts: 3,
        initialDelayMs: 1,
        maxDelayMs: 2,
      });
    }
    const cancel = spyOn(backend, "cancelRun");
    try {
      await settingsManager.initialize();
      const turn = handleIncomingMessage(
        {
          type: "message",
          agentId,
          conversationId,
          messages: [{ role: "user", content: "Create the requested file" }],
          clientToolset: { base: "default", include: ["ApplyPatch"] },
        },
        socket,
        runtime,
        undefined,
        options.connectionId,
      );
      if (interrupt) {
        for (let attempt = 0; !runtime.activeRunId && attempt < 500; attempt++)
          await Bun.sleep(2);
        expect(runtime.activeRunId).toBe(firstRunId ?? null);
        expect(
          await handleAbortMessageInput(listener, {
            command: {
              type: "abort_message",
              runtime: { agent_id: agentId, conversation_id: conversationId },
            },
            socket,
            opts: options,
            processQueuedTurn: async () => {},
          }),
        ).toBe(true);
      }
      await turn;
      expect(runtime.pendingApprovalResolvers.size).toBe(0);
      if (interrupt) {
        expect(cancel).toHaveBeenCalledWith(agentId, firstRunId);
        expect(resume).not.toHaveBeenCalled();
        expect(existsSync(output)).toBe(false);
      } else if (closeKind === "exhausted") {
        expect(resume).toHaveBeenCalledTimes(3);
        expect(runtime.lastStopReason).toBe("error");
        expect(existsSync(output)).toBe(false);
        expect(
          sent.some(
            (data) =>
              data.includes('"loop_error"') &&
              data.includes("Run stream unavailable"),
          ),
        ).toBe(true);
      } else {
        expect(resume).toHaveBeenCalledTimes(closeKind === "retry" ? 2 : 1);
        expect(resume.mock.calls[0]?.[0]).toBe(firstRunId);
        expect(resume.mock.calls[0]?.[1]?.starting_after).toBe(1);
        expect(readFileSync(output, "utf8")).toBe("resumed\n");
        expect(create).toHaveBeenCalledTimes(2);
        expect(create.mock.calls[1]?.[1]).toMatchObject({
          messages: [
            {
              type: "approval",
              approvals: [
                {
                  type: "tool",
                  tool_call_id: "call-early-close",
                  status: "success",
                },
              ],
            },
          ],
        });
        expect(runtime.lastStopReason).toBe("end_turn");
      }
      const tail = await getResumeDataFromBackend(
        await backend.retrieveAgent(agentId),
        conversationId,
        { throwOnReadError: true },
      );
      if (closeKind !== "exhausted") expect(tail.pendingApprovals).toEqual([]);
    } finally {
      Object.assign(LISTENER_STREAM_RESUME_POLICY, savedPolicy);
      create.mockRestore();
      resume.mockRestore();
      cancel.mockRestore();
      disposeListenerModAdapter(listener);
      __listenerWarmupTestUtils.resetWarmupDepsForTests();
      __listenerModAdapterTestUtils.resetForTests();
      clearCapturedToolExecutionContexts();
      setActiveRuntime(null);
      setCurrentAgentId(null);
      setCurrentAgentName(null);
      setConversationId(null);
      __testSetBackend(null);
      await settingsManager.reset();
      restoreEnv();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      directory.cleanup();
    }
  }, 20000);
}
