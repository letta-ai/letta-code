/**
 * Agent startup steps that run before the background task exists. Each
 * returns its error instead of throwing so a launch can report it either in
 * the foreground or, after the startup budget, from the task.
 */
import { getConversationId, getCurrentAgentId } from "@/agent/context";
import type { SubagentConfig } from "@/agent/subagents";
import { forkParentConversation } from "@/agent/subagents/fork-conversation";
import { spawnSubagent } from "@/agent/subagents/manager";
import { getBackend } from "@/backend";
import { awaitDeferredStartup } from "./agent-startup";
import type { ExternalCodingAgentMcpOptions } from "./external-coding-agent";
import { resolveExternalCodingAgentMcpReminder } from "./external-coding-agent";
import { prepareExternalWorkerPrompt } from "./external-fork-context";

type StartupError = { error: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Build a local external worker's prompt and MCP reminder. */
export async function prepareLocalExternalWorker(params: {
  prompt: string;
  forkContext: boolean;
  parentAgentId: string;
  parentConversationId?: string;
  mcp?: ExternalCodingAgentMcpOptions;
  signal?: AbortSignal;
}): Promise<{ prompt: string; mcpReminder?: string } | StartupError> {
  const worker = await prepareExternalWorkerPrompt(params);
  if ("error" in worker) return worker;
  try {
    const mcpReminder = await resolveExternalCodingAgentMcpReminder(
      params.parentAgentId,
      params.mcp,
    );
    return { prompt: worker.prompt, mcpReminder };
  } catch (error) {
    return { error: message(error) };
  }
}

/** Fork the parent conversation for a fork subagent. */
export async function forkSubagentConversation(params: {
  parentScope?: { agentId: string; conversationId: string };
  config: SubagentConfig;
  model?: string;
  signal?: AbortSignal;
}): Promise<{ agentId: string; conversationId: string } | StartupError> {
  try {
    const agentId = params.parentScope?.agentId ?? getCurrentAgentId();
    const forked = await forkParentConversation({
      backend: getBackend(),
      parentAgentId: agentId,
      parentConversationId:
        params.parentScope?.conversationId ?? getConversationId() ?? "default",
      config: params.config,
      model: params.model,
      signal: params.signal,
    });
    return { agentId, conversationId: forked.id };
  } catch (error) {
    return { error: `Failed to fork parent conversation: ${message(error)}` };
  }
}

/** Spawn a fork subagent in its task once a fork still pending finishes. */
export function spawnWhenForked(
  fork: Promise<{ agentId: string; conversationId: string } | StartupError>,
): typeof spawnSubagent {
  return async (...spawnArgs) => {
    const ready = await awaitDeferredStartup(fork, spawnArgs[4]);
    if ("error" in ready) throw new Error(ready.error);
    spawnArgs[5] = ready.agentId;
    spawnArgs[6] = ready.conversationId;
    return spawnSubagent(...spawnArgs);
  };
}
