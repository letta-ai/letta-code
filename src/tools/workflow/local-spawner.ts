/**
 * Native local Workflow workers. Each call starts a persisted agent-free
 * conversation in this process's local App Server; no SDK (whose query() rejects
 * local harnesses), Cloud backend, or synthetic worker agent is involved.
 */

import { randomUUID } from "node:crypto";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import WebSocket from "ws";
import {
  AppServerClient,
  type AppServerSocketConstructor,
} from "@/app-server-client";
import type { TurnFinishedMessage } from "@/types/protocol_v2";
import type { ConversationRuntimeScope } from "@/types/runtime-scope";
import { type AppServerHandle, startAppServer } from "@/websocket/app-server";
import { getActiveRuntime } from "@/websocket/listener/runtime";
import {
  DEFAULT_MAX_SUBAGENT_TOOL_CALLS,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  MAX_IDENTICAL_TOOL_CALLS,
  parseJsonReply,
  type SdkSpawnerConfig,
} from "./sdk-spawner";
import type {
  SubagentOutcome,
  SubagentRequest,
  SubagentSpawner,
  SubagentSpawnHooks,
} from "./types";

export interface LocalSpawnerHandle {
  spawner: SubagentSpawner;
  cleanup(): Promise<void>;
}

const WORKER_PREAMBLE =
  "You are a subagent inside a deterministic workflow. Your final output is consumed by a script. Return raw data with no preamble, markdown framing, or questions.";
const JSON_PREAMBLE =
  "Your final message must be a single JSON value, without prose or a markdown code fence.";

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        item && typeof item === "object" && "text" in item
          ? String(item.text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

function toolCallKey(name: string, args: string): string {
  try {
    return `${name}:${JSON.stringify(JSON.parse(args))}`;
  } catch {
    return `${name}:${args}`;
  }
}

function toolCallFromDelta(delta: Record<string, unknown>): {
  id: string;
  name: string;
  arguments: string;
} | null {
  if (
    delta.message_type !== "tool_call_message" &&
    delta.message_type !== "approval_request_message"
  ) {
    return null;
  }
  const call = delta.tool_call;
  if (!call || typeof call !== "object") return null;
  const value = call as Record<string, unknown>;
  if (typeof value.tool_call_id !== "string") return null;
  return {
    id: value.tool_call_id,
    name: typeof value.name === "string" ? value.name : "?",
    arguments:
      typeof value.arguments === "string"
        ? value.arguments
        : JSON.stringify(value.arguments ?? {}),
  };
}

function assertWorkerIdentity(
  scope: ConversationRuntimeScope | null,
  conversation: Record<string, unknown> | null,
  parentAgentId: string,
): asserts scope is ConversationRuntimeScope {
  if (
    !scope ||
    scope.agent_id !== null ||
    !scope.conversation_id ||
    conversation?.agent_id !== null ||
    conversation?.parent_agent_id !== parentAgentId ||
    conversation?.is_subagent !== true
  ) {
    throw new Error(
      "Local Workflow worker creation did not persist agent_id:null, parent_agent_id, and is_subagent:true",
    );
  }
}

async function runWorker(
  client: AppServerClient,
  config: SdkSpawnerConfig,
  request: SubagentRequest,
  signal: AbortSignal,
  hooks?: SubagentSpawnHooks,
): Promise<SubagentOutcome> {
  const startedAt = Date.now();
  const { options } = request;
  const model = options.model
    ? (config.resolveModel?.(options.model) ?? null)
    : config.model;
  if (!model) {
    return {
      value: null,
      failed: true,
      error: `Unknown model "${options.model}". Run \`letta model list\` for valid handles.`,
    };
  }
  if (
    options.maxToolCalls !== undefined &&
    (!Number.isSafeInteger(options.maxToolCalls) || options.maxToolCalls < 1)
  ) {
    return {
      value: null,
      failed: true,
      error: "maxToolCalls must be a positive safe integer",
    };
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
  ) {
    return {
      value: null,
      failed: true,
      error: "timeoutMs must be a positive safe integer",
    };
  }
  if (signal.aborted) {
    return {
      value: null,
      failed: true,
      error: "Workflow subagent interrupted",
    };
  }
  // The local provider ignores response_format. Validate the parsed result in
  // the harness rather than claiming unverified provider structured output.
  let validate: ReturnType<AjvJsonSchemaValidator["getValidator"]> | undefined;
  try {
    validate = options.schema
      ? new AjvJsonSchemaValidator().getValidator(options.schema)
      : undefined;
  } catch (error) {
    return {
      value: null,
      failed: true,
      error: `Invalid Workflow schema: ${String(error)}`,
    };
  }
  const system = [
    WORKER_PREAMBLE,
    options.json || options.schema ? JSON_PREAMBLE : undefined,
    options.schema
      ? `Return JSON matching this schema: ${JSON.stringify(options.schema)}`
      : undefined,
    options.systemPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
  let scope: ConversationRuntimeScope | undefined;
  let totalTokens = 0;
  let turnTokens = 0;
  let toolCalls = 0;
  let lastCall = "";
  let repeated = 0;
  const seen = new Set<string>();
  let finalText = "";
  let validationError: string | undefined;
  const maxSchemaAttempts = options.schema ? 3 : 1;
  let terminalError: string | undefined;
  let terminated = false;
  let awaitingTurn = false;
  let turnInFlight = false;
  const finishedTurnIds = new Set<string>();
  let finish!: (message: TurnFinishedMessage | Error) => void;
  let completion!: Promise<TurnFinishedMessage | Error>;
  const resetCompletion = () => {
    awaitingTurn = false;
    completion = new Promise<TurnFinishedMessage | Error>((resolve) => {
      finish = resolve;
    });
  };
  resetCompletion();
  const stop = (reason: string) => {
    if (terminated) return;
    terminated = true;
    terminalError = reason;
    finish(new Error(reason));
  };
  const checkToolCall = (key: string, name: string) => {
    toolCalls++;
    repeated = key === lastCall ? repeated + 1 : 1;
    lastCall = key;
    const cap = options.maxToolCalls ?? DEFAULT_MAX_SUBAGENT_TOOL_CALLS;
    if (toolCalls > cap) {
      stop(`subagent exceeded ${cap} tool calls`);
    } else if (repeated >= MAX_IDENTICAL_TOOL_CALLS) {
      stop(`subagent repeated the identical ${name} call ${repeated} times`);
    }
  };
  const onAbort = () => stop("Workflow subagent interrupted");
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
  const timeout = setTimeout(
    () => stop(`Workflow subagent timed out after ${timeoutMs}ms`),
    timeoutMs,
  );
  const unsubscribe = client.onMessage((message) => {
    if (
      !scope ||
      !("runtime" in message) ||
      message.runtime?.conversation_id !== scope.conversation_id ||
      message.runtime.agent_id !== null ||
      terminated
    )
      return;
    if (message.type === "stream_delta") {
      const delta = message.delta as unknown as Record<string, unknown>;
      if (delta.message_type === "assistant_message") {
        finalText += contentText(delta.content);
      }
      if (delta.message_type === "client_tool_start") {
        const id = delta.tool_call_id;
        if (typeof id === "string" && !seen.has(id)) {
          seen.add(id);
          const name = String(delta.tool_name ?? "?");
          const key = toolCallKey(name, String(delta.tool_args ?? ""));
          checkToolCall(key, name);
        }
      }
      if (delta.message_type === "usage_statistics") {
        const tokens = delta.total_tokens;
        if (typeof tokens === "number" && Number.isFinite(tokens)) {
          totalTokens += tokens;
          turnTokens += tokens;
          hooks?.onUsage?.(totalTokens);
        }
      }
      const call = toolCallFromDelta(delta);
      if (call && !seen.has(call.id)) {
        seen.add(call.id);
        checkToolCall(toolCallKey(call.name, call.arguments), call.name);
      }
    }
    if (
      message.type === "input_accepted" &&
      !message.accepted &&
      awaitingTurn
    ) {
      stop(message.error ?? "Workflow worker input rejected");
    }
    if (
      message.type === "turn_finished" &&
      awaitingTurn &&
      !finishedTurnIds.has(message.turn_id)
    ) {
      finishedTurnIds.add(message.turn_id);
      awaitingTurn = false;
      turnInFlight = false;
      finish(message);
    }
  });
  const disconnect = client.onDisconnect(() => {
    stop("Local Workflow App Server disconnected");
  });
  try {
    if (terminated || signal.aborted) {
      throw new Error(terminalError ?? "Workflow subagent interrupted");
    }
    const started = client.runtimeStart({
      create_conversation: {
        body: {
          model,
          system,
          parent_agent_id: config.parentAgentId,
          is_subagent: true,
          summary: options.label ?? `Workflow worker ${request.callIndex + 1}`,
        },
      },
      ...(config.cwd ? { cwd: config.cwd } : {}),
      mode: "unrestricted",
      execution_settings: {
        allowed_tools: options.allowedTools ?? config.allowedTools ?? [],
        disallowed_tools: [],
        parent_agent_id: config.parentAgentId,
        agent_role: "subagent",
        disable_memory_guard: false,
      },
      skill_sources: [],
      recover_approvals: false,
      wait_for_replay: true,
    });
    const created = await Promise.race([
      started,
      completion.then((outcome) => {
        if (outcome instanceof Error) throw outcome;
        throw new Error("Workflow worker completed before runtime_start");
      }),
    ]);
    if (!created.success) {
      throw new Error(created.error ?? "runtime_start failed");
    }
    scope = created.runtime ?? undefined;
    assertWorkerIdentity(
      created.runtime,
      created.conversation as Record<string, unknown> | null,
      config.parentAgentId,
    );
    const workerScope = created.runtime;
    if (terminated || signal.aborted) {
      // An abort during runtime_start can precede knowledge of the scope.
      // Now that the scope exists, issue the scoped abort before disconnect.
      stop("Workflow subagent interrupted");
      throw new Error(terminalError ?? "Workflow subagent interrupted");
    }
    for (let attempt = 0; attempt < maxSchemaAttempts; attempt++) {
      if (terminated || signal.aborted) {
        throw new Error(terminalError ?? "Workflow subagent interrupted");
      }
      finalText = "";
      const prompt =
        attempt === 0
          ? request.prompt
          : `Your previous reply did not validate against the JSON schema: ${validationError}. Reply again with ONLY corrected JSON matching ${JSON.stringify(options.schema)}.`;
      awaitingTurn = true;
      turnInFlight = true;
      const submitted = client.submitInput({
        runtime: workerScope,
        payload: {
          kind: "create_message",
          messages: [{ role: "user", content: prompt }],
          client_tool_allowlist:
            options.allowedTools ?? config.allowedTools ?? [],
          client_toolset: { base: "letta" },
          exclude_interactive_tools: true,
        },
      });
      const accepted = await Promise.race([
        submitted,
        completion.then((outcome) => {
          if (outcome instanceof Error) throw outcome;
          // A turn can finish before its input acknowledgement is delivered.
          return { accepted: true } as Awaited<typeof submitted>;
        }),
      ]);
      if (terminated) {
        throw new Error(terminalError ?? "Workflow subagent interrupted");
      }
      if (!accepted.accepted) {
        throw new Error(accepted.error ?? "input rejected");
      }
      const finished = await completion;
      if (terminated || signal.aborted) {
        throw new Error(terminalError ?? "Workflow subagent interrupted");
      }
      if (finished instanceof Error) throw finished;
      if (
        typeof finished.usage?.total_tokens === "number" &&
        turnTokens === 0
      ) {
        totalTokens += finished.usage.total_tokens;
        hooks?.onUsage?.(totalTokens);
      }
      turnTokens = 0;
      if (finished.stop_reason !== "end_turn") {
        throw new Error(
          finished.error ??
            `Workflow subagent stopped: ${finished.stop_reason}`,
        );
      }
      let value: unknown;
      try {
        value =
          options.json || validate
            ? parseJsonReply(finalText)
            : finalText.trim();
      } catch (error) {
        validationError = `Invalid JSON: ${String(error)}`;
        if (attempt + 1 === maxSchemaAttempts) {
          throw new Error(validationError);
        }
        resetCompletion();
        continue;
      }
      if (validate) {
        const result = validate(value);
        if (!result.valid) {
          validationError = result.errorMessage;
          if (attempt + 1 === maxSchemaAttempts) {
            throw new Error(
              `Subagent reply failed JSON Schema validation: ${validationError}`,
            );
          }
          resetCompletion();
          continue;
        }
        value = result.data;
      }
      return {
        value,
        failed: false,
        conversationId: workerScope.conversation_id,
        durationMs: Date.now() - startedAt,
        totalTokens,
      };
    }
    throw new Error(
      `Subagent reply failed JSON Schema validation: ${validationError}`,
    );
  } catch (error) {
    if (scope && (terminated || signal.aborted || turnInFlight)) {
      await client.abort({ runtime: scope }).catch(() => undefined);
    }
    return {
      value: null,
      failed: true,
      error: error instanceof Error ? error.message : String(error),
      ...(scope ? { conversationId: scope.conversation_id } : {}),
      durationMs: Date.now() - startedAt,
      totalTokens,
    };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
    unsubscribe();
    disconnect();
  }
}

/** One process-owned server; each worker has a separate connection and scope. */
export async function createLocalSpawnerHandle(
  config: SdkSpawnerConfig,
): Promise<LocalSpawnerHandle> {
  // A Workflow launched by an app-server turn must attach to that listener:
  // starting an owned server here would stop the active runtime and cancel
  // the invoking parent turn. Headless/TUI have no active listener, so the
  // server owns a dedicated runtime there.
  const runtime = getActiveRuntime();
  const server: AppServerHandle = await startAppServer({
    listen: "ws://127.0.0.1:0",
    startProcessServices: false,
    ...(runtime ? { runtime } : {}),
    connectionName: `workflow-${randomUUID()}`,
  });
  const clients = new Set<AppServerClient>();
  return {
    spawner: async (request, signal, hooks) => {
      const client = new AppServerClient({
        url: server.controlUrl,
        WebSocket: WebSocket as unknown as AppServerSocketConstructor,
      });
      clients.add(client);
      try {
        await client.connect();
        return await runWorker(client, config, request, signal, hooks);
      } catch (error) {
        return {
          value: null,
          failed: true,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clients.delete(client);
        client.close();
      }
    },
    cleanup: async () => {
      for (const client of clients) client.close();
      clients.clear();
      await server.close();
    },
  };
}
