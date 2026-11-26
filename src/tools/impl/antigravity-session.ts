import { createInterface } from "node:readline";
import type { SubagentResult } from "@/agent/subagents";
import { spawnManagedWorkloadProcess } from "@/agent/subagents/subagent-process";
import {
  createSecretStreamScrubber,
  scrubSecretsFromString,
} from "@/tools/secret-substitution";
import { isRecord } from "@/utils/type-guards";
import {
  type ExternalWorkerListeners,
  emitProgress,
  formatExternalToolCallArgs,
  toolOutputText,
} from "./external-tool-call";
import {
  persistNativeSessionOwner,
  readNativeSessionOwner,
} from "./native-session-owner";

const sessions = new Map<string, { queue: string[]; closing: boolean }>();
const sessionPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
interface Options extends ExternalWorkerListeners {
  cwd: string;
  parentAgentId: string;
  parentConversationId?: string;
  prompt: string;
  model?: string;
  resumeSessionId?: string;
  mcpReminder?: string;
  signal?: AbortSignal;
  onStarted?: (agentId: string) => void;
}

export async function runAntigravityTurn(
  options: Options,
  env: NodeJS.ProcessEnv,
  secrets: Record<string, string>,
): Promise<SubagentResult> {
  const start = Date.now();
  if (env.GEMINI_API_KEY)
    secrets = { ...secrets, GEMINI_API_KEY: env.GEMINI_API_KEY };
  let sessionId = options.resumeSessionId;
  const state = { queue: [] as string[], closing: false };
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const base = {
    model: options.model,
    report: "",
    agentId: options.parentAgentId,
  };
  try {
    signal.throwIfAborted();
    const args = [
      "--mode",
      "accept-edits",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--disable-slash-commands",
    ];
    if (env.GEMINI_API_KEY)
      args.push("--settings", '{"modelProvider":"gemini"}');
    if (sessionId) {
      const owner = readNativeSessionOwner("antigravity", sessionId);
      if (
        !sessionPattern.test(sessionId) ||
        owner?.agentId !== options.parentAgentId
      )
        throw new Error("Antigravity session does not belong to this agent");
      if (sessions.has(sessionId))
        throw new Error("Antigravity session is already running");
      sessions.set(sessionId, state);
      args.push("--conversation", sessionId);
      options = {
        ...options,
        cwd: owner.cwd ?? options.cwd,
        model: options.model ?? owner.model,
      };
    }
    if (options.model) args.push("--model", options.model);
    const running = spawnManagedWorkloadProcess("agy", args, {
      cwd: options.cwd,
      env,
      signal,
    });
    const child = running.process;
    let diagnostic = "";
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.stderr.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk).slice(-2048);
    });
    child.stdin.on("error", () => {});
    const lines = createInterface({ input: child.stdout });
    const send = (content: string) =>
      child.stdin.write(
        `${JSON.stringify({ event: "user", message: { content } })}\n`,
      );
    send([options.mcpReminder, options.prompt].filter(Boolean).join("\n\n"));
    let report: string | undefined;
    let error: string | undefined;
    let initialized = false;
    const text = createSecretStreamScrubber(secrets);
    const tools = new Set<number>();
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const event: unknown = JSON.parse(line);
        if (!isRecord(event)) throw new Error("Invalid Antigravity event");
        if (event.event === "init") {
          const id = event.conversation_id;
          if (
            initialized ||
            typeof id !== "string" ||
            !sessionPattern.test(id) ||
            (sessionId && id !== sessionId) ||
            (!sessionId && sessions.has(id))
          )
            throw new Error("Invalid Antigravity conversation ID");
          sessionId = id;
          if (!options.resumeSessionId)
            persistNativeSessionOwner("antigravity", id, {
              agentId: options.parentAgentId,
              conversationId: options.parentConversationId ?? "default",
              cwd: options.cwd,
              model: options.model,
            });
          if (
            readNativeSessionOwner("antigravity", id)?.agentId !==
            options.parentAgentId
          )
            throw new Error("Antigravity session owner mismatch");
          sessions.set(id, state);
          initialized = true;
          options.onStarted?.(`antigravity_${id}`);
        } else if (
          event.event === "step_update" &&
          isRecord(event.step_update)
        ) {
          const step = event.step_update;
          if (!initialized || step.conversation_id !== sessionId)
            throw new Error("Unexpected Antigravity step conversation");
          if (
            step.step_type === "agent_response" &&
            typeof step.text_delta === "string"
          ) {
            const delta = text.push(step.text_delta);
            if (delta) emitProgress(options.onText, delta);
          }
          if (
            step.step_type === "tool" &&
            typeof step.step_index === "number" &&
            typeof step.tool_name === "string"
          ) {
            const info = isRecord(step.tool_info) ? step.tool_info : {};
            const id = `step-${step.step_index}`;
            if (!tools.has(step.step_index)) {
              tools.add(step.step_index);
              emitProgress(options.onToolCall, {
                id,
                name: step.tool_name,
                args: formatExternalToolCallArgs(info.parameters),
              });
            }
            if (step.state === "DONE")
              emitProgress(options.onToolResult, {
                id,
                name: step.tool_name,
                isError: !!info.error,
                output: toolOutputText(info.error ?? info.output),
              });
          }
        } else if (event.event === "result" && isRecord(event.result)) {
          const result = event.result;
          const tail = text.flush();
          if (tail) emitProgress(options.onText, tail);
          if (result.status !== "SUCCESS")
            error =
              typeof result.error === "string"
                ? result.error
                : "Antigravity turn failed";
          else if (
            !initialized ||
            result.conversation_id !== sessionId ||
            typeof result.response !== "string" ||
            state.closing
          )
            throw new Error("Invalid Antigravity result");
          const next = !error && state.queue.shift();
          if (next) {
            tools.clear();
            send(next);
          } else {
            state.closing = true;
            report =
              typeof result.response === "string" ? result.response : undefined;
            child.stdin.end();
          }
        }
      }
      const { exitCode } = await running.completion;
      signal.throwIfAborted();
      if ((spawnError as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
        throw new Error("Required executable 'agy' was not found on PATH");
      if (
        !initialized &&
        /authentication required|authentication failed/i.test(
          `${diagnostic}\n${error}`,
        )
      )
        throw new Error(
          "Antigravity is not signed in: run agy to authenticate",
        );
      if (
        spawnError ||
        error ||
        exitCode !== 0 ||
        report === undefined ||
        !sessionId
      )
        throw (
          spawnError ??
          new Error(
            error || diagnostic.trim() || "Antigravity exited without a result",
          )
        );
      return {
        ...base,
        agentId: `antigravity_${sessionId}`,
        runtimeSessionId: sessionId,
        report: scrubSecretsFromString(report, secrets),
        success: true,
        durationMs: Date.now() - start,
      };
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null)
        controller.abort();
      await running.completion;
    }
  } catch (error) {
    return {
      ...base,
      success: false,
      error: scrubSecretsFromString(
        error instanceof Error ? error.message : String(error),
        secrets,
      ),
      durationMs: Date.now() - start,
    };
  } finally {
    if (sessionId && sessions.get(sessionId) === state)
      sessions.delete(sessionId);
  }
}

export function sendAntigravityMessage(
  options: Options & { resumeSessionId: string },
  env: NodeJS.ProcessEnv,
  secrets: Record<string, string>,
) {
  const id = options.resumeSessionId;
  if (
    readNativeSessionOwner("antigravity", id)?.agentId !== options.parentAgentId
  )
    throw new Error("Antigravity session does not belong to this agent");
  const active = sessions.get(id);
  if (active) {
    if (active.closing)
      throw new Error(
        "Antigravity session is finishing; retry after completion",
      );
    active.queue.push(options.prompt);
    return { mode: "steered" as const, queued: true };
  }
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const completion = runAntigravityTurn({ ...options, signal }, env, secrets);
  return {
    mode: "resumed" as const,
    completion,
    interrupt: async () => {
      controller.abort();
      await completion;
    },
  };
}
