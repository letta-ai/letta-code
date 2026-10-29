import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import WebSocket from "ws";
import {
  AppServerClient,
  type AppServerSocketConstructor,
} from "@/app-server-client";
import {
  parseAskUserQuestionReceipt,
  prepareAskUserQuestionNotif,
} from "@/ask-user-question";
import { __testSetBackend } from "@/backend";
import {
  createAssistantMessageStream,
  type HeadlessTurnExecutorInput,
} from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local";
import { settingsManager } from "@/settings-manager";
import { isolateAmbientLettaTestEnv } from "@/test-utils/test-process-env";
import type {
  TeleportReadyMessage,
  WsProtocolMessage,
} from "@/types/app-server-protocol";
import { type AppServerHandle, startAppServer } from "./app-server";

const questions = [
  {
    question: "Which warehouse?",
    header: "Warehouse",
    options: [
      { label: "Snowflake", description: "Read-only SQL" },
      { label: "BigQuery", description: "Read-only SQL" },
    ],
  },
];

function serializedClientTools(
  input: HeadlessTurnExecutorInput | undefined,
): string {
  const body = input?.body;
  if (!body || !("client_tools" in body))
    throw new Error("Missing client_tools");
  return JSON.stringify(body.client_tools);
}

function callTool(
  name: string,
  toolCallId: string,
  args: object,
): Stream<LettaStreamingResponse> {
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      yield {
        message_type: "approval_request_message",
        tool_call: {
          name,
          tool_call_id: toolCallId,
          arguments: JSON.stringify(args),
        },
      } as LettaStreamingResponse;
      yield {
        message_type: "stop_reason",
        stop_reason: "requires_approval",
      } as LettaStreamingResponse;
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

function waitForTurn(client: AppServerClient): Promise<WsProtocolMessage[]> {
  return new Promise((resolve, reject) => {
    const frames: WsProtocolMessage[] = [];
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Turn did not finish: ${JSON.stringify(frames)}`));
    }, 15_000);
    const unsubscribe = client.onMessage((frame) => {
      frames.push(frame);
      if (frame.type !== "turn_finished") return;
      clearTimeout(timer);
      unsubscribe();
      resolve(frames);
    });
  });
}

test.each(["answered", "dismissed"] as const)(
  "app-server completes questions and another tool before receiving a later %s notification",
  async (status) => {
    const directory = await mkdtemp(join(tmpdir(), "async-question-server-"));
    const oldHome = process.env.HOME;
    const oldMods = process.env.LETTA_DISABLE_MODS;
    const oldCron = process.env.LETTA_DISABLE_CRON_SCHEDULER;
    const restoreEnv = isolateAmbientLettaTestEnv();
    process.env.HOME = directory;
    process.env.LETTA_DISABLE_MODS = "1";
    process.env.LETTA_DISABLE_CRON_SCHEDULER = "1";
    const fixture = join(directory, "independent-work.txt");
    await writeFile(fixture, "INDEPENDENT_WORK_FINISHED");
    let server: AppServerHandle | undefined;
    let client: AppServerClient | undefined;
    const inputs: HeadlessTurnExecutorInput[] = [];
    const backend = new LocalBackend({
      storageDir: join(directory, "backend"),
      memfsEnabled: false,
      executor: {
        async execute(input) {
          inputs.push(input);
          if (inputs.length === 1)
            return callTool("AskUserQuestion", "question-1", { questions });
          if (inputs.length === 2)
            return callTool("Read", "independent-read", { file_path: fixture });
          return createAssistantMessageStream({
            content: [
              {
                type: "text",
                text:
                  inputs.length === 3
                    ? "I continued working without an answer."
                    : "Response received.",
              },
            ],
          });
        },
      },
    });
    __testSetBackend(backend);
    try {
      await settingsManager.reset();
      await settingsManager.initialize();
      const agent = await backend.createAgent({
        name: "Async question fixture",
        model: "anthropic/claude-sonnet-4-6",
      });
      settingsManager.setMemfsEnabled(agent.id, false);
      server = await startAppServer({ listen: "ws://127.0.0.1:0" });
      client = await new AppServerClient({
        url: server.controlUrl,
        WebSocket: WebSocket as unknown as AppServerSocketConstructor,
      }).connect();
      const started = await client.runtimeStart({
        agent_id: agent.id,
        create_conversation: { body: {} },
        skill_sources: [],
        recover_approvals: false,
        wait_for_replay: true,
      });
      if (!started.runtime) throw new Error("Runtime did not start");
      const runtime = started.runtime;
      const firstFinished = waitForTurn(client);
      client.input({
        runtime,
        payload: {
          kind: "create_message",
          client_preferences: { toolset: { include: ["AskUserQuestion"] } },
          messages: [
            {
              role: "user",
              content: "Ask me a question, then read the fixture.",
            },
          ],
        },
      });
      const firstFrames = await firstFinished;
      expect(
        firstFrames.some((frame) => frame.type === "control_request"),
      ).toBe(false);
      expect(
        firstFrames.some(
          (frame) =>
            frame.type === "update_loop_status" &&
            frame.loop_status.status === "WAITING_ON_APPROVAL",
        ),
      ).toBe(false);
      expect(inputs).toHaveLength(3);
      const firstTools = serializedClientTools(inputs[0]);
      expect(firstTools).toContain('"name":"AskUserQuestion"');
      for (const input of inputs) {
        expect(serializedClientTools(input)).toBe(firstTools);
      }
      expect(
        settingsManager.getClientPreferences(agent.id, runtime.conversation_id),
      ).toEqual({ toolset: { include: ["AskUserQuestion"] } });
      const questionResultInput = inputs[1]?.body;
      if (!questionResultInput || !("messages" in questionResultInput))
        throw new Error("Question result request missing");
      const approvalMessage = questionResultInput.messages?.find(
        (message) => message.type === "approval",
      );
      if (!approvalMessage || approvalMessage.type !== "approval")
        throw new Error("Question receipt missing");
      const receiptResult = approvalMessage.approvals?.find(
        (approval) => approval.type === "tool",
      );
      if (!receiptResult || receiptResult.type !== "tool")
        throw new Error("Question tool result missing");
      const receipt = parseAskUserQuestionReceipt(receiptResult.tool_return);
      expect(receipt?.toolCallId).toBe("question-1");
      expect(JSON.stringify(inputs[2]?.body)).toContain(
        "INDEPENDENT_WORK_FINISHED",
      );
      const notification = prepareAskUserQuestionNotif({
        type: "ask_user_question_response",
        version: 2,
        toolCallId: "question-1",
        questions,
        status,
        ...(status === "answered"
          ? { answers: { "Which warehouse?": "Snowflake" } }
          : {}),
      });
      const secondFinished = waitForTurn(client);
      client.input({
        runtime,
        payload: {
          kind: "create_message",
          messages: [{ role: "user", content: notification }],
        },
      });
      await secondFinished;
      expect(inputs).toHaveLength(4);
      expect(serializedClientTools(inputs[3])).toBe(firstTools);
      const repeatedFinished = waitForTurn(client);
      client.input({
        runtime,
        payload: {
          kind: "create_message",
          client_preferences: { toolset: { include: ["AskUserQuestion"] } },
          messages: [{ role: "user", content: "Continue from the UI." }],
        },
      });
      await repeatedFinished;
      expect(inputs).toHaveLength(5);
      expect(serializedClientTools(inputs[4])).toBe(firstTools);
      expect(JSON.stringify(inputs[3]?.body)).toContain(
        "ask-user-question-response",
      );
      const persisted = await backend.listConversationMessages(
        runtime.conversation_id,
        { limit: 100, order: "asc" },
      );
      const messages = persisted.getPaginatedItems();
      const storedReceipt = messages.find(
        (message) =>
          message.message_type === "tool_return_message" &&
          message.tool_call_id === "question-1",
      );
      if (storedReceipt?.message_type !== "tool_return_message")
        throw new Error("Persisted question receipt missing");
      expect(
        parseAskUserQuestionReceipt(storedReceipt.tool_return)?.toolCallId,
      ).toBe("question-1");
      const transcript = JSON.stringify(messages);
      expect(transcript).toContain("question-1");
      expect(transcript).toContain("I continued working without an answer.");
      expect(transcript).toContain("ask-user-question-response");
      expect(transcript).toContain(`User ${status} your questions.`);

      const sourceClient = client;
      const readyPromise = new Promise<TeleportReadyMessage>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            unsubscribe();
            reject(new Error("Teleport did not become ready"));
          }, 15_000);
          const unsubscribe = sourceClient.onMessage((frame) => {
            if (frame.type !== "teleport_ready") return;
            clearTimeout(timer);
            unsubscribe();
            resolve(frame);
          });
        },
      );
      client.send({
        type: "teleport_request",
        request_id: "transfer-preferences",
        teleport_id: "transfer-preferences",
        runtime: { ...runtime, agent_id: agent.id },
        target: {
          connection_id: "destination",
          device_id: "destination",
          connection_name: "Destination",
        },
      });
      const ready = await readyPromise;
      expect(ready.success).toBe(true);
      expect(ready.client_preferences).toEqual({
        toolset: { include: ["AskUserQuestion"] },
      });

      // Restart the listener with no local defaults, as on a fresh destination.
      // Only the wire snapshot below can restore this conversation's opt-in.
      client.close();
      await server.close();
      settingsManager.setClientPreferences(
        agent.id,
        runtime.conversation_id,
        {},
      );
      server = await startAppServer({ listen: "ws://127.0.0.1:0" });
      client = await new AppServerClient({
        url: server.controlUrl,
        WebSocket: WebSocket as unknown as AppServerSocketConstructor,
      }).connect();
      const destination = await client.runtimeStart({
        agent_id: agent.id,
        conversation_id: runtime.conversation_id,
        skill_sources: [],
        recover_approvals: false,
        wait_for_replay: true,
        teleport_id: ready.teleport_id,
      });
      expect(destination.success).toBe(true);
      expect(destination.runtime).toEqual(runtime);
      const transferred = waitForTurn(client);
      client.input({
        runtime,
        payload: {
          kind: "teleport_continue",
          teleport_id: ready.teleport_id,
          source: { device_id: "source", connection_name: "Source" },
          client_preferences: ready.client_preferences,
        },
      });
      await transferred;
      expect(inputs).toHaveLength(6);
      expect(serializedClientTools(inputs[5])).toBe(firstTools);
      expect(
        settingsManager.getClientPreferences(agent.id, runtime.conversation_id),
      ).toEqual(ready.client_preferences);

      const cleared = waitForTurn(client);
      client.input({
        runtime,
        payload: {
          kind: "teleport_continue",
          teleport_id: "clear-preferences",
          source: { device_id: "source", connection_name: "Source" },
          client_preferences: {},
        },
      });
      await cleared;
      expect(inputs).toHaveLength(7);
      const clearedTools = serializedClientTools(inputs[6]);
      expect(clearedTools).not.toContain('"name":"AskUserQuestion"');
      expect(clearedTools).not.toBe(firstTools);
      expect(
        settingsManager.getClientPreferences(agent.id, runtime.conversation_id),
      ).toEqual({});

      const inheritedClear = waitForTurn(client);
      client.input({
        runtime,
        payload: {
          kind: "create_message",
          messages: [
            { role: "user", content: "Continue without UI defaults." },
          ],
        },
      });
      await inheritedClear;
      expect(inputs).toHaveLength(8);
      expect(serializedClientTools(inputs[7])).toBe(clearedTools);
    } finally {
      client?.close();
      await server?.close();
      __testSetBackend(null);
      await settingsManager.reset();
      restoreEnv();
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldMods === undefined) delete process.env.LETTA_DISABLE_MODS;
      else process.env.LETTA_DISABLE_MODS = oldMods;
      if (oldCron === undefined)
        delete process.env.LETTA_DISABLE_CRON_SCHEDULER;
      else process.env.LETTA_DISABLE_CRON_SCHEDULER = oldCron;
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
