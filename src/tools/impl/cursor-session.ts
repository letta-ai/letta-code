import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ACTING_USER_ID_ENV } from "@/agent/acting-user";
import type { SubagentResult } from "@/agent/subagents";
import { getCurrentSubagentDepth } from "@/agent/subagents/subagent-depth";
import { spawnManagedWorkloadProcess } from "@/agent/subagents/subagent-process";
import {
  getRuntimeActingUserAttribution,
  getRuntimeContext,
} from "@/runtime-context";
import { scrubSecretsFromString } from "@/tools/secret-substitution";
import { resolveGlobalConfigDir } from "@/utils/settings-path";
import { SUBAGENT_DEPTH_ENV } from "@/utils/subagent-depth-env";
import type { CursorWorkerEvent, CursorWorkerStart } from "./cursor-worker";
import type { ExternalToolCallListener } from "./external-tool-call";

interface CursorTurnOptions {
  prompt: string;
  parentAgentId: string;
  actingUserId?: string | null;
  cwd: string;
  model?: string;
  mcpReminder?: string;
  signal?: AbortSignal;
  resumeSessionId?: string;
  onStarted?: (sessionId: string) => void;
  onToolCall?: ExternalToolCallListener;
}

interface ActiveTurn {
  completion: Promise<SubagentResult>;
  steer: (prompt: string) => Promise<boolean>;
  interrupt: () => Promise<void>;
}

const sessions = new Map<string, ActiveTurn>();
const queued = new Map<
  string,
  { completion: Promise<SubagentResult>; started: boolean }
>();
const followupControllers = new Set<AbortController>();
const locks = new Map<string, Promise<unknown>>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function key(options: CursorTurnOptions, id: string): string {
  if (!UUID.test(id) || !/^[\w-]+$/.test(options.parentAgentId))
    throw new Error("Invalid Cursor session or parent ID");
  return `${options.parentAgentId}/${id}`;
}

export function resolveCursorWorkerPath(): string {
  const source = fileURLToPath(new URL("./cursor-worker.ts", import.meta.url));
  if (existsSync(source)) return source;
  const bundled = fileURLToPath(new URL("./cursor-worker.js", import.meta.url));
  if (!existsSync(bundled))
    throw new Error("Cursor worker is missing; reinstall Letta Code.");
  return bundled;
}

export async function runCursorTurn(
  options: CursorTurnOptions,
  env: NodeJS.ProcessEnv = process.env,
  secrets: Record<string, string> = {},
): Promise<SubagentResult> {
  const id = options.resumeSessionId ?? randomUUID();
  const startedAt = Date.now();
  const redact = (text: string) =>
    scrubSecretsFromString(text, {
      ...secrets,
      ...(env.CURSOR_API_KEY ? { CURSOR_API_KEY: env.CURSOR_API_KEY } : {}),
    });
  const base = {
    agentId: `cursor_${id}`,
    runtimeSessionId: id,
    model: options.model,
  };
  let sessionKey: string | undefined;
  let active: ActiveTurn | undefined;
  try {
    options.signal?.throwIfAborted();
    sessionKey = key(options, id);
    if (sessions.has(sessionKey))
      throw new Error("Cursor session already has an active turn");
    if (!env.CURSOR_API_KEY)
      throw new Error(
        "Cursor is not signed in: add CURSOR_API_KEY to the agent's secrets or the selected computer's environment.",
      );
    if (!options.resumeSessionId && !options.model)
      throw new Error(
        "Cursor requires an explicit model on the first Agent call; pick an ID from `letta model list --worker cursor`.",
      );
    const lifetime = new AbortController();
    const actor =
      options.actingUserId !== undefined
        ? options.actingUserId
        : getRuntimeActingUserAttribution();
    const workerEnv = { ...env };
    if (typeof actor === "string") workerEnv[ACTING_USER_ID_ENV] = actor;
    else if (actor === null || getRuntimeContext()?.suppressActingUserFallback)
      delete workerEnv[ACTING_USER_ID_ENV];
    const abort = () => lifetime.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const running = spawnManagedWorkloadProcess(
      process.execPath,
      [resolveCursorWorkerPath()],
      {
        cwd: options.cwd,
        env: {
          ...workerEnv,
          AGENT_ID: options.parentAgentId,
          LETTA_AGENT_ID: options.parentAgentId,
          LETTA_PARENT_AGENT_ID: options.parentAgentId,
          LETTA_CODE_AGENT_ROLE: "subagent",
          [SUBAGENT_DEPTH_ENV]: String(getCurrentSubagentDepth() + 1),
        },
        signal: lifetime.signal,
      },
    );
    let result: SubagentResult | undefined;
    let stderr = "";
    let requestId = 0;
    const pending = new Map<
      number,
      { resolve: (delivered: boolean) => void; reject: (error: Error) => void }
    >();
    const output = createInterface({ input: running.process.stdout });
    running.process.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    running.process.on("error", (error) => {
      stderr = error.message;
    });
    running.process.stdin.on("error", (error) => {
      stderr = error.message;
      lifetime.abort();
    });
    output.on("line", (line) => {
      if (!line.startsWith("letta-cursor:")) return;
      try {
        const event = JSON.parse(
          line.slice("letta-cursor:".length),
        ) as CursorWorkerEvent;
        if (event.type === "started") options.onStarted?.(id);
        else if (event.type === "tool")
          options.onToolCall?.({
            id: event.id,
            name: event.name,
            args: redact(JSON.stringify(event.args ?? {})).slice(0, 1000),
          });
        else if (event.type === "steer") {
          const waiter = pending.get(event.id);
          pending.delete(event.id);
          if (event.error) waiter?.reject(new Error(redact(event.error)));
          else waiter?.resolve(event.delivered);
        } else if (event.type === "error")
          result = {
            ...base,
            success: false,
            report: "",
            error: redact(event.error),
          };
        else if (event.type === "result")
          result = {
            ...base,
            model: event.result.model?.id ?? options.model,
            success: event.result.status === "finished",
            report: redact(event.result.result ?? ""),
            ...(event.result.status !== "finished"
              ? {
                  error: redact(
                    event.result.error?.message ??
                      `Cursor run ${event.result.status}`,
                  ),
                }
              : {}),
          };
      } catch (error) {
        stderr = String(error);
        lifetime.abort();
      }
    });
    const completion = running.completion.then(({ exitCode }) => {
      output.close();
      options.signal?.removeEventListener("abort", abort);
      for (const waiter of pending.values())
        waiter.reject(
          new Error(
            "Cursor exited before confirming delivery; delivery is unknown.",
          ),
        );
      pending.clear();
      if (lifetime.signal.aborted || exitCode !== 0 || !result)
        return {
          ...base,
          success: false,
          report: result?.report ?? "",
          error: lifetime.signal.aborted
            ? "Cursor turn cancelled"
            : redact(stderr || `Cursor exited (${exitCode}) without a result`),
          durationMs: Date.now() - startedAt,
        };
      return { ...result, durationMs: Date.now() - startedAt };
    });
    active = {
      completion,
      steer: (prompt) =>
        new Promise<boolean>((resolve, reject) => {
          const request = ++requestId;
          pending.set(request, { resolve, reject });
          running.process.stdin.write(
            `${JSON.stringify({ type: "steer", id: request, prompt })}\n`,
          );
        }),
      interrupt: async () => {
        lifetime.abort();
        await completion;
      },
    };
    sessions.set(sessionKey, active);
    const command: CursorWorkerStart = {
      type: "start",
      sessionId: id,
      resume: !!options.resumeSessionId,
      stateDir: join(resolveGlobalConfigDir(), "cursor-sessions", sessionKey),
      cwd: options.cwd,
      model: options.model,
      reminder: options.mcpReminder,
      prompt: options.prompt,
    };
    running.process.stdin.write(`${JSON.stringify(command)}\n`);
    return await completion;
  } catch (error) {
    return {
      ...base,
      success: false,
      report: "",
      error: redact(error instanceof Error ? error.message : String(error)),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (sessionKey && active && sessions.get(sessionKey) === active)
      sessions.delete(sessionKey);
  }
}

export async function sendCursorMessage(
  options: Omit<CursorTurnOptions, "resumeSessionId"> & { sessionId: string },
  env: NodeJS.ProcessEnv = process.env,
  secrets: Record<string, string> = {},
): Promise<{
  mode: "steered" | "new_turn";
  completion?: Promise<SubagentResult>;
  interrupt?: () => Promise<void>;
}> {
  const sessionKey = key(options, options.sessionId);
  const previousLock = locks.get(sessionKey) ?? Promise.resolve();
  const operation = previousLock
    .catch(() => undefined)
    .then(async () => {
      options.signal?.throwIfAborted();
      const active = sessions.get(sessionKey);
      const tail = queued.get(sessionKey);
      if (
        (!tail || tail.started) &&
        active &&
        (await active.steer(options.prompt))
      )
        return { mode: "steered" as const };
      // A declined steer is a new tracked turn, never a claim of in-flight delivery.
      // Serialize follow-ups and wait for the previous process to release its store.
      const controller = new AbortController();
      followupControllers.add(controller);
      const waitingFor =
        tail?.completion ?? active?.completion ?? Promise.resolve();
      const scheduled = waitingFor.then(() => {
        next.started = true;
        return runCursorTurn(
          {
            ...options,
            resumeSessionId: options.sessionId,
            signal: controller.signal,
          },
          env,
          secrets,
        );
      });
      const next = { completion: scheduled, started: false };
      queued.set(sessionKey, next);
      void scheduled.finally(() => {
        followupControllers.delete(controller);
        if (queued.get(sessionKey) === next) queued.delete(sessionKey);
      });
      // Cancelling a waiting follow-up must not cancel the preceding task or wait
      // for it. Keep the serialization tail until the preceding process exits.
      const cancelled = new Promise<SubagentResult>((resolve) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            if (!next.started)
              resolve({
                agentId: `cursor_${options.sessionId}`,
                success: false,
                report: "",
                error: "Cursor follow-up cancelled before start",
              });
          },
          { once: true },
        );
      });
      const completion = Promise.race([scheduled, cancelled]);
      return {
        mode: "new_turn" as const,
        completion,
        interrupt: async () => {
          controller.abort();
          await completion;
        },
      };
    });
  locks.set(sessionKey, operation);
  try {
    return await operation;
  } finally {
    if (locks.get(sessionKey) === operation) locks.delete(sessionKey);
  }
}

/** Cursor's curated catalog via the SDK worker; the API also accepts other model keys. */
export async function listCursorModels(
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): Promise<unknown[]> {
  if (!env.CURSOR_API_KEY)
    throw new Error(
      "Cursor is not signed in: add CURSOR_API_KEY to the agent's secrets or the selected computer's environment.",
    );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const running = spawnManagedWorkloadProcess(
    process.execPath,
    [resolveCursorWorkerPath()],
    { cwd, env, signal: controller.signal },
  );
  let event: CursorWorkerEvent | undefined;
  let stderr = "";
  const output = createInterface({ input: running.process.stdout });
  output.on("line", (line) => {
    if (line.startsWith("letta-cursor:"))
      event = JSON.parse(line.slice("letta-cursor:".length));
  });
  running.process.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  running.process.on("error", (error) => {
    stderr = error.message;
  });
  running.process.stdin.on("error", () => {});
  running.process.stdin.end(`${JSON.stringify({ type: "models" })}\n`);
  try {
    await running.completion;
  } finally {
    clearTimeout(timer);
    output.close();
  }
  if (event?.type === "models") {
    if (!Array.isArray(event.models))
      throw new Error("Cursor did not return a model catalog");
    return event.models;
  }
  throw new Error(
    controller.signal.aborted
      ? "Cursor model discovery timed out"
      : event?.type === "error"
        ? event.error
        : `Cursor exited without a model catalog: ${stderr}`,
  );
}

export async function closeCursorSessions(): Promise<void> {
  for (const controller of followupControllers) controller.abort();
  await Promise.all(
    [...sessions.values()].map((session) => session.interrupt()),
  );
  await Promise.all([...queued.values()].map((turn) => turn.completion));
}
