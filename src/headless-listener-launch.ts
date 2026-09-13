import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import WebSocket from "ws";
import {
  type AppServerClient,
  createAppServerClient,
} from "@/app-server-client";
import type { Backend } from "@/backend";
import {
  dequeueConversationMessage,
  enqueueConversationMessage,
  getLatestConversationSuperRun,
  listEnqueuedRunMessages,
} from "@/backend/api/conversation-enqueue";
import { getApiRequestConfig } from "@/backend/api/request";
import type { RuntimeExecutionSettings } from "@/runtime-execution-settings";
import type { UsageStatistics } from "@/types/protocol";
import type {
  AgentRuntimeScope,
  ConversationRuntimeScope,
  LoopState,
  MessageDelta,
  RuntimeStartCommand,
  TurnFinishedMessage,
} from "@/types/protocol_v2";
import { resolveEnvironmentMaxWaitMs } from "./headless-environment-response";

export function listenerControlUrl(
  baseUrl: string,
  connectionId: string,
  scope: ConversationRuntimeScope,
): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `/v1/environments/${encodeURIComponent(connectionId)}/status/ws`;
  url.search = new URLSearchParams({
    ...(scope.agent_id ? { agentId: scope.agent_id } : {}),
    conversationId: scope.conversation_id,
  }).toString();
  return url.toString();
}

async function createListenerClient(
  connectionId: string,
  scope: AgentRuntimeScope,
): Promise<AppServerClient> {
  const auth = await getApiRequestConfig();
  return createAppServerClient({
    url: listenerControlUrl(auth.baseUrl, connectionId, scope),
    authToken: auth.apiKey,
    WebSocket,
    requestTimeoutMs: 30_000,
  });
}

/** Cancel only this input: a queued child must not interrupt the turn ahead of it. */
export async function cancelListenerInput(params: {
  client: AppServerClient;
  scope: AgentRuntimeScope;
  clientMessageId: string;
  dequeue?: typeof dequeueConversationMessage;
  readState: () => {
    loop?: LoopState;
    cancelled: boolean;
  };
}): Promise<boolean> {
  const removed = await (params.dequeue ?? dequeueConversationMessage)(
    {
      agentId: params.scope.agent_id,
      conversationId: params.scope.conversation_id,
      clientMessageId: params.clientMessageId,
    },
    AbortSignal.timeout(30_000),
  );
  if (removed.status === "dequeued" || removed.status === "already_dequeued")
    return true;
  await params.client.sync({ runtime: params.scope, recover_approvals: false });
  const { loop, cancelled } = params.readState();
  if (cancelled) return true;
  const ownRun = loop?.active_run_ids.find((id) =>
    loop.client_message_ids_by_run_id?.[id]?.includes(params.clientMessageId),
  );
  if (!ownRun) return false;
  const response = await params.client.abort({
    runtime: params.scope,
    run_id: ownRun,
  });
  if (!response.success)
    throw new Error(response.error ?? "Listener rejected cancellation");
  return response.aborted;
}

/** The CLI remains the caller; the existing listener owns model and tool execution. */
export async function launchListenerConversation(
  params: {
    connectionId: string;
    scope: AgentRuntimeScope;
    content: MessageCreate["content"];
    backend: Pick<Backend, "retrieveRun">;
    settings: RuntimeExecutionSettings;
    cwd?: string;
    mode: RuntimeStartCommand["mode"];
    skillSources?: RuntimeStartCommand["skill_sources"];
    onMessage?: (message: MessageDelta) => void;
    signal?: AbortSignal;
  },
  deps: {
    client?: AppServerClient;
    enqueue?: typeof enqueueConversationMessage;
    dequeue?: typeof dequeueConversationMessage;
    latestSuperRun?: typeof getLatestConversationSuperRun;
    listRunMessages?: typeof listEnqueuedRunMessages;
    pollMs?: number;
    waitDeadline?: AbortSignal;
  } = {},
): Promise<{
  text: string;
  stopReason: StopReasonType | null;
  runIds: string[];
  usage: UsageStatistics;
}> {
  const client =
    deps.client ??
    (await createListenerClient(params.connectionId, params.scope));
  const clientMessageId = randomUUID();
  const runIds = new Set<string>();
  let loop: LoopState | undefined;
  let cancelled = false;
  let disconnected = false;
  let interrupted = params.signal?.aborted ?? false;
  let terminalError: string | undefined;
  const finishedByRunId = new Map<string, TurnFinishedMessage>();
  let completedWithoutText: { runId: string; at: number } | undefined;
  let cancellationStarted: number | undefined;
  const interruptReads = new AbortController();
  const waitDeadline =
    deps.waitDeadline ?? AbortSignal.timeout(resolveEnvironmentMaxWaitMs());
  const waitSignal = AbortSignal.any([interruptReads.signal, waitDeadline]);
  const onSignal = () => {
    interrupted = true;
    interruptReads.abort();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  params.signal?.addEventListener("abort", onSignal, { once: true });
  const detach = client.onMessage((message) => {
    const seq = Reflect.get(message, "seq");
    if (typeof seq === "number") client.sendRaw({ type: "ack", seq });
    if (
      !("runtime" in message) ||
      !message.runtime ||
      message.runtime.agent_id !== params.scope.agent_id ||
      message.runtime.conversation_id !== params.scope.conversation_id
    )
      return;
    if (message.type === "update_loop_status") {
      loop = message.loop_status;
      for (const [runId, ids] of Object.entries(
        loop.client_message_ids_by_run_id ?? {},
      )) {
        if (ids.includes(clientMessageId)) runIds.add(runId);
      }
    } else if (message.type === "update_queue") {
      cancelled ||= message.removed.some(
        (entry) =>
          entry.client_message_id === clientMessageId &&
          entry.disposition === "cancelled",
      );
    } else if (message.type === "turn_finished") {
      if (message.run_id) finishedByRunId.set(message.run_id, message);
    } else if (message.type === "stream_delta") {
      const delta = message.delta;
      const runId = Reflect.get(delta, "run_id");
      const belongsToInput =
        typeof runId === "string"
          ? runIds.has(runId)
          : loop?.active_run_ids.some((id) => runIds.has(id));
      if (!belongsToInput) return;
      if ("type" in delta && delta.type === "message") {
        params.onMessage?.(delta);
      }
      if (
        delta.message_type === "loop_error" &&
        delta.is_terminal !== false &&
        delta.run_id &&
        runIds.has(delta.run_id)
      )
        terminalError = delta.message;
    }
  });
  const detachDisconnect = client.onDisconnect(() => {
    disconnected = true;
  });
  async function read<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const signal = AbortSignal.any([waitSignal, AbortSignal.timeout(30_000)]);
    signal.throwIfAborted();
    try {
      const value = await operation(signal);
      signal.throwIfAborted();
      return value;
    } catch (error) {
      if (signal.aborted && !waitSignal.aborted)
        throw new Error(
          "Listener read timed out; execution may still be running. Do not resend automatically.",
        );
      throw error;
    }
  }
  try {
    await client.connect();
    const runtime = await client.runtimeStart({
      agent_id: params.scope.agent_id ?? undefined,
      conversation_id: params.scope.conversation_id,
      cwd: params.cwd,
      mode: params.mode,
      execution_settings: params.settings,
      ...(params.skillSources !== undefined
        ? { skill_sources: params.skillSources }
        : { preserve_skill_sources: true }),
      recover_approvals: false,
      wait_for_replay: true,
    });
    if (!runtime.success)
      throw new Error(runtime.error ?? "Listener rejected launch settings");
    if (!runtime.execution_settings)
      throw new Error(
        "This listener does not support scoped CLI launch settings; upgrade it before launching children",
      );
    if (interrupted) throw new Error("Launch cancelled before input was sent");
    const accepted = await (deps.enqueue ?? enqueueConversationMessage)(
      {
        agentId: params.scope.agent_id,
        conversationId: params.scope.conversation_id,
        clientMessageId,
        content: params.content,
        computer: params.connectionId,
        actingUserId: params.scope.acting_user_id,
      },
      AbortSignal.timeout(30_000),
    );
    while (true) {
      if (disconnected)
        throw new Error(
          "Listener connection closed; execution may still be running. Do not resend automatically.",
        );
      if (cancelled) throw new Error("Listener input cancelled");
      if (terminalError) throw new Error(terminalError);
      if (interrupted) {
        cancellationStarted ??= Date.now();
        if (
          await cancelListenerInput({
            client,
            scope: params.scope,
            clientMessageId,
            dequeue: deps.dequeue,
            readState: () => ({ loop, cancelled }),
          })
        ) {
          throw new Error("Listener execution cancelled");
        }
        if (Date.now() - cancellationStarted > 30_000)
          throw new Error(
            "Could not confirm listener cancellation; execution may still be running",
          );
        // Cancellation has its own deadline and requests. Never feed it the
        // already-aborted signal used to interrupt status/result reads.
        await delay(deps.pollMs ?? 1000);
        continue;
      }
      try {
        waitSignal.throwIfAborted();
        const runId = [...runIds].at(-1);
        const ownFinished = runId ? finishedByRunId.get(runId) : undefined;
        if (ownFinished && ownFinished.stop_reason !== "end_turn")
          throw new Error(
            ownFinished.error ??
              `Listener turn stopped (${ownFinished.stop_reason})`,
          );
        if (!runId && params.scope.conversation_id !== "default") {
          const latest = await read((signal) =>
            (deps.latestSuperRun ?? getLatestConversationSuperRun)(
              params.scope.conversation_id,
              signal,
            ),
          );
          if (
            latest.id === accepted.super_run_id &&
            (latest.errored_at || latest.cancelled_at)
          )
            throw new Error(
              `Accepted send ${latest.id} ${latest.errored_at ? "failed" : "was cancelled"} before a run was observed`,
            );
        }
        if (runId) {
          const run = await read((signal) =>
            params.backend.retrieveRun(runId, { signal }),
          );
          if (run.status === "failed" || run.status === "cancelled")
            throw new Error(
              `Listener run ${run.status} (${run.stop_reason ?? "unknown reason"})`,
            );
          if (
            run.status === "completed" &&
            run.stop_reason !== "requires_approval" &&
            ownFinished
          ) {
            const messages = await read((signal) =>
              (deps.listRunMessages ?? listEnqueuedRunMessages)(runId, signal),
            );
            const last = messages
              .filter((message) => message.message_type === "assistant_message")
              .sort((a, b) => (b.seq_id ?? 0) - (a.seq_id ?? 0))[0];
            if (last?.message_type === "assistant_message") {
              const text =
                typeof last.content === "string"
                  ? last.content
                  : last.content
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join("\n");
              if (text.trim())
                return {
                  text,
                  stopReason: run.stop_reason ?? null,
                  runIds: [...runIds],
                  usage: ownFinished.usage ?? {},
                };
            }
            if (completedWithoutText?.runId !== runId)
              completedWithoutText = { runId, at: Date.now() };
            if (Date.now() - completedWithoutText.at >= 15_000)
              throw new Error(
                `Listener run completed without an assistant reply (${run.stop_reason ?? "unknown reason"})`,
              );
          }
        }
        await delay(deps.pollMs ?? 1000, undefined, { signal: waitSignal });
      } catch (error) {
        if (interrupted) continue;
        if (waitDeadline.aborted)
          throw new Error(
            "Stopped waiting for the listener; execution may still be running. Do not resend automatically.",
          );
        throw error;
      }
    }
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    params.signal?.removeEventListener("abort", onSignal);
    detach();
    detachDisconnect();
    client.close();
  }
}
