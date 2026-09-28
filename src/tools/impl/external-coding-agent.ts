import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { SubagentConfig, SubagentResult } from "@/agent/subagents";
import { spawnSubagentProcess } from "@/agent/subagents/subagent-process";
import {
  buildMcpServersReminderText,
  listMcpServersForAgent,
} from "@/reminders/engine";
import { createSharedReminderState } from "@/reminders/state";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { runClaudeTurn } from "./claude-stream-session";
import { runCodexTurn } from "./codex-app-server";

export const EXTERNAL_CODING_AGENT_TYPES = ["claude-code", "codex"] as const;
export type ExternalCodingAgentType =
  (typeof EXTERNAL_CODING_AGENT_TYPES)[number];

export interface ExternalCodingAgentMcpOptions {
  inherit: boolean;
  servers?: string[];
}

export interface ExternalCodingAgentMcpEntry {
  name: string;
  toolCount: number | null;
}

export interface ExternalCodingAgentRunOptions {
  type: ExternalCodingAgentType;
  prompt: string;
  model?: string;
  parentAgentId: string;
  resumeSessionId?: string;
  cwd?: string;
  mcpReminder?: string;
  signal?: AbortSignal;
  onStarted?: (agentId: string) => void;
}

export interface ExternalCodingAgentCommand {
  executable: string;
  args: string[];
  stdin?: string;
}

export function createExternalCodingAgentConfig(
  type: ExternalCodingAgentType,
): SubagentConfig {
  return {
    name: type,
    description: "External coding agent",
    systemPrompt: "",
    allowedTools: "all",
    recommendedModel: "inherit",
    skills: [],
    fork: false,
    launchProfile: "default",
  };
}

export interface ExternalCodingAgentProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ExternalCodingAgentDependencies {
  runCodexTurn?: typeof runCodexTurn;
  runProcess?: (
    command: ExternalCodingAgentCommand,
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      signal?: AbortSignal;
    },
  ) => Promise<ExternalCodingAgentProcessResult>;
  runPreflight?: (
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ) => Promise<ExternalCodingAgentProcessResult>;
  env?: NodeJS.ProcessEnv;
}

export function isExternalCodingAgentType(
  value: string,
): value is ExternalCodingAgentType {
  return (EXTERNAL_CODING_AGENT_TYPES as readonly string[]).includes(value);
}

const EXTERNAL_AGENT_ID_PREFIXES: Record<ExternalCodingAgentType, string> = {
  "claude-code": "claude_",
  codex: "codex_",
};
const NATIVE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatExternalCodingAgentId(
  type: ExternalCodingAgentType,
  sessionId: string,
): string {
  return `${EXTERNAL_AGENT_ID_PREFIXES[type]}${sessionId}`;
}

export function parseExternalCodingAgentId(
  agentId: string | undefined,
): { type: ExternalCodingAgentType; sessionId: string } | null {
  if (!agentId) return null;
  for (const type of EXTERNAL_CODING_AGENT_TYPES) {
    const prefix = EXTERNAL_AGENT_ID_PREFIXES[type];
    if (agentId.startsWith(prefix)) {
      const sessionId = agentId.slice(prefix.length);
      if (NATIVE_SESSION_ID_PATTERN.test(sessionId)) {
        return { type, sessionId };
      }
    }
  }
  return null;
}

export function validateExternalCodingAgentMcpOptions(
  mcp: ExternalCodingAgentMcpOptions | undefined,
): string | null {
  if (!mcp) return null;
  if (typeof mcp.inherit !== "boolean") return "mcp.inherit must be a boolean";
  if (mcp.servers !== undefined) {
    if (
      !Array.isArray(mcp.servers) ||
      mcp.servers.some(
        (server) => typeof server !== "string" || server.trim().length === 0,
      )
    ) {
      return "mcp.servers must contain only non-empty server names";
    }
    if (!mcp.inherit) {
      return "mcp.servers requires mcp.inherit to be true";
    }
  }
  return null;
}

export function selectExternalCodingAgentMcpEntries(
  inventory: ExternalCodingAgentMcpEntry[],
  requestedServers?: string[],
): ExternalCodingAgentMcpEntry[] {
  const byName = new Map(inventory.map((entry) => [entry.name, entry]));
  if (!requestedServers) return [...byName.values()];
  const uniqueRequested = [...new Set(requestedServers)];
  const missing = uniqueRequested.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Requested MCP ${missing.length === 1 ? "server is" : "servers are"} not available to the parent agent: ${missing.join(", ")}`,
    );
  }
  return uniqueRequested.map(
    (name) => byName.get(name) as ExternalCodingAgentMcpEntry,
  );
}

export function buildExternalCodingAgentMcpReminder(
  entries: ExternalCodingAgentMcpEntry[],
): string {
  return buildMcpServersReminderText(entries);
}

/**
 * Resolve the parent agent's MCP servers into the discovery reminder passed to
 * an external coding agent. Returns undefined when inheritance is not
 * requested; throws when the inventory cannot be read.
 */
export async function resolveExternalCodingAgentMcpReminder(
  parentAgentId: string,
  mcp: ExternalCodingAgentMcpOptions | undefined,
): Promise<string | undefined> {
  if (!mcp?.inherit) return undefined;
  const inventory = await listMcpServersForAgent(
    parentAgentId,
    createSharedReminderState(),
  );
  return buildExternalCodingAgentMcpReminder(
    selectExternalCodingAgentMcpEntries(inventory, mcp.servers),
  );
}

export function buildExternalCodingAgentCommand(
  options: Pick<
    ExternalCodingAgentRunOptions,
    "type" | "prompt" | "model" | "resumeSessionId" | "cwd" | "mcpReminder"
  >,
): ExternalCodingAgentCommand {
  if (options.type === "claude-code") {
    const args = [
      "--print",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "acceptEdits",
      "--allowed-tools",
      "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch",
    ];
    if (options.model) args.push("--model", options.model);
    if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
    }
    if (options.mcpReminder) {
      args.push("--append-system-prompt", options.mcpReminder);
    }
    return { executable: "claude", args, stdin: options.prompt };
  }

  return { executable: "codex", args: ["app-server", "--stdio"] };
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runProcess(
  command: ExternalCodingAgentCommand,
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<ExternalCodingAgentProcessResult> {
  const running = spawnSubagentProcess(
    command.executable,
    command.args,
    options,
  );
  let stdout = "";
  let stderr = "";
  running.process.stdout.setEncoding("utf8");
  running.process.stderr.setEncoding("utf8");
  running.process.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  running.process.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  running.process.stdin.end(command.stdin);
  const result = await running.completion;
  return { exitCode: result.exitCode, stdout, stderr };
}

async function defaultRunPreflight(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<ExternalCodingAgentProcessResult> {
  signal?.throwIfAborted();
  const running = spawnSubagentProcess(executable, args, {
    cwd: getCurrentWorkingDirectory(),
    env,
    signal,
  });
  const child = running.process;
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const errorPromise = once(child, "error").then(([error]) => {
    throw error;
  });
  const closePromise = running.completion.then(({ exitCode }) => exitCode);
  try {
    const exitCode = await Promise.race([closePromise, errorPromise]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `Required executable '${executable}' was not found on PATH`,
      );
    }
    throw error;
  }
}

function preflightArgs(type: ExternalCodingAgentType): string[] {
  return type === "claude-code" ? ["auth", "status", "--json"] : ["--version"];
}

function assertPreflightReady(
  type: ExternalCodingAgentType,
  result: ExternalCodingAgentProcessResult,
): void {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (type === "claude-code") {
    try {
      const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown };
      if (result.exitCode === 0 && parsed.loggedIn === true) return;
    } catch {
      // Fall through to the concrete status error below.
    }
  } else if (result.exitCode === 0) {
    return;
  }
  throw new Error(
    type === "codex"
      ? `Codex executable is not ready${output ? `: ${output}` : ""}`
      : `${type} authentication is not ready${output ? `: ${output}` : ""}`,
  );
}

export function parseExternalCodingAgentOutput(
  type: ExternalCodingAgentType,
  stdout: string,
): { report: string; sessionId?: string } {
  if (type === "claude-code") {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    if (value.is_error === true) {
      throw new Error(
        typeof value.result === "string" ? value.result : "Claude Code failed",
      );
    }
    return {
      report: typeof value.result === "string" ? value.result : stdout.trim(),
      ...(typeof value.session_id === "string"
        ? { sessionId: value.session_id }
        : {}),
    };
  }

  let report = "";
  let sessionId: string | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const value = JSON.parse(line) as Record<string, unknown>;
    if (
      value.type === "thread.started" &&
      typeof value.thread_id === "string"
    ) {
      sessionId = value.thread_id;
    }
    if (value.type === "item.completed") {
      const item = value.item;
      if (
        item &&
        typeof item === "object" &&
        (item as Record<string, unknown>).type === "agent_message" &&
        typeof (item as Record<string, unknown>).text === "string"
      ) {
        report = (item as Record<string, unknown>).text as string;
      }
    }
  }
  return {
    report: report || stdout.trim(),
    ...(sessionId ? { sessionId } : {}),
  };
}

export async function runExternalCodingAgent(
  options: ExternalCodingAgentRunOptions,
  deps: ExternalCodingAgentDependencies = {},
): Promise<SubagentResult> {
  const startedAt = Date.now();
  const env = {
    ...(deps.env ?? process.env),
    AGENT_ID: options.parentAgentId,
    LETTA_AGENT_ID: options.parentAgentId,
  };
  const cwd = options.cwd ?? getCurrentWorkingDirectory();
  try {
    options.signal?.throwIfAborted();
  } catch (error) {
    return {
      agentId: options.parentAgentId,
      model: options.model,
      report: "",
      success: false,
      error: normalizeError(error),
      durationMs: Date.now() - startedAt,
    };
  }
  if (options.type === "codex") {
    try {
      const preflight = await (deps.runPreflight ?? defaultRunPreflight)(
        "codex",
        preflightArgs("codex"),
        env,
        options.signal,
      );
      assertPreflightReady("codex", preflight);
      // The managed sandbox wrapper authenticates model requests with its
      // sandbox key, not native `codex login`. A real app-server turn is the
      // authority on whether the configured provider can answer.
      return (deps.runCodexTurn ?? runCodexTurn)(
        {
          prompt: options.prompt,
          parentAgentId: options.parentAgentId,
          cwd,
          model: options.model,
          mcpReminder: options.mcpReminder,
          signal: options.signal,
          resumeThreadId: options.resumeSessionId,
          onStarted: (threadId) =>
            options.onStarted?.(formatExternalCodingAgentId("codex", threadId)),
        },
        { env },
      );
    } catch (error) {
      return {
        agentId: options.parentAgentId,
        model: options.model,
        report: "",
        success: false,
        error: normalizeError(error),
        durationMs: Date.now() - startedAt,
      };
    }
  }
  try {
    const preflight = await (deps.runPreflight ?? defaultRunPreflight)(
      options.type === "claude-code" ? "claude" : "codex",
      preflightArgs(options.type),
      env,
      options.signal,
    );
    assertPreflightReady(options.type, preflight);
    if (options.type === "claude-code" && !deps.runProcess) {
      const sessionId = options.resumeSessionId ?? randomUUID();
      options.onStarted?.(
        formatExternalCodingAgentId("claude-code", sessionId),
      );
      return runClaudeTurn(
        {
          prompt: options.prompt,
          parentAgentId: options.parentAgentId,
          cwd,
          model: options.model,
          mcpReminder: options.mcpReminder,
          signal: options.signal,
          resumeSessionId: options.resumeSessionId,
          sessionId,
        },
        { env },
      );
    }
    const result = await (deps.runProcess ?? runProcess)(
      buildExternalCodingAgentCommand({ ...options, cwd }),
      { cwd, env, signal: options.signal },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `${options.type} exited with code ${result.exitCode ?? "unknown"}: ${(result.stderr || result.stdout).trim()}`,
      );
    }
    const parsed = parseExternalCodingAgentOutput(options.type, result.stdout);
    if (!parsed.sessionId) {
      throw new Error(
        `${options.type} completed without a resumable session ID`,
      );
    }
    return {
      agentId: formatExternalCodingAgentId(options.type, parsed.sessionId),
      runtimeSessionId: parsed.sessionId,
      model: options.model,
      report: parsed.report,
      success: true,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message = normalizeError(error);
    return {
      agentId: options.parentAgentId,
      model: options.model,
      report: "",
      success: false,
      error: message,
      durationMs: Date.now() - startedAt,
    };
  }
}
