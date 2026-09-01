/**
 * Remote-environment subagent execution.
 *
 * Instead of spawning a local child process, a remote subagent turn is routed
 * to a connected environment (another computer running a Letta Code listener)
 * through environment-routed messaging: the prompt is delivered as a v2-input
 * message for an existing conversation, the remote listener runs the turn
 * there, and completion is detected by polling the conversation's messages —
 * the same mechanism `letta -p --environment` uses.
 */

import { randomUUID } from "node:crypto";
import { updateSubagent } from "@/agent/subagent-state.js";
import type { SubagentResult } from "@/agent/subagents";
import { getBackend } from "@/backend";
import {
  type EnvironmentConnection,
  getEnvironmentRoutedMessagingUnsupportedReason,
  isCloudEnvironmentSelector,
  resolveAgentSandboxConnectionId,
  resolveEnvironmentConnectionId,
  sendEnvironmentMessage,
} from "@/backend/api/environments";
import { buildAgentReference } from "@/cli/helpers/app-urls";
import { INTERRUPTED_BY_USER } from "@/constants";
import { waitForEnvironmentAssistantMessage } from "@/headless-environment-response";

/**
 * Default wall-clock budget for one remote subagent turn. Remote turns run a
 * full agentic task on another machine, so this is intentionally much longer
 * than the 10-minute headless reply default.
 */
export const REMOTE_SUBAGENT_TIMEOUT_MS = 60 * 60_000;

export interface RemoteEnvironmentRouting {
  connectionId: string;
  environment: EnvironmentConnection;
}

interface ResolveRoutingDeps {
  resolveEnvironment?: typeof resolveEnvironmentConnectionId;
  resolveSandbox?: typeof resolveAgentSandboxConnectionId;
}

/**
 * Resolve an Agent-tool environment selector to a live connection and verify
 * the target listener supports environment-routed messaging. Throws with a
 * human-readable reason otherwise.
 */
export async function resolveRemoteEnvironmentRouting(
  selector: string,
  target: { agentId: string; conversationId?: string },
  deps: ResolveRoutingDeps = {},
): Promise<RemoteEnvironmentRouting> {
  const resolveEnvironment =
    deps.resolveEnvironment ?? resolveEnvironmentConnectionId;
  const resolveSandbox = deps.resolveSandbox ?? resolveAgentSandboxConnectionId;

  const routing = isCloudEnvironmentSelector(selector)
    ? await resolveSandbox(target.agentId, {
        conversationId: target.conversationId,
      })
    : await resolveEnvironment(selector);

  const unsupportedReason = getEnvironmentRoutedMessagingUnsupportedReason(
    routing.environment,
  );
  if (unsupportedReason) {
    throw new Error(unsupportedReason);
  }
  return routing;
}

export interface RemoteSubagentParams {
  routing: RemoteEnvironmentRouting;
  /** Agent that owns the conversation the remote environment will run. */
  agentId: string;
  /** Existing conversation the remote turn runs in (forked or deployed). */
  conversationId: string;
  prompt: string;
  /** Subagent state-store id registered by the Task tool. */
  subagentId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface ExecuteRemoteSubagentDeps {
  sendMessage?: typeof sendEnvironmentMessage;
  waitForAssistantMessage?: typeof waitForEnvironmentAssistantMessage;
  updateSubagentState?: typeof updateSubagent;
  getBackendImpl?: typeof getBackend;
}

/**
 * Execute one remote subagent turn and collect its final assistant message as
 * the report. Returns a SubagentResult shaped like local execution; token and
 * step statistics are unavailable over this path.
 */
export async function executeRemoteSubagent(
  params: RemoteSubagentParams,
  deps: ExecuteRemoteSubagentDeps = {},
): Promise<SubagentResult> {
  const sendMessage = deps.sendMessage ?? sendEnvironmentMessage;
  const waitForAssistantMessage =
    deps.waitForAssistantMessage ?? waitForEnvironmentAssistantMessage;
  const updateSubagentState = deps.updateSubagentState ?? updateSubagent;
  const getBackendFn = deps.getBackendImpl ?? getBackend;

  const base = {
    agentId: params.agentId,
    conversationId: params.conversationId,
  };

  if (params.signal?.aborted) {
    return { ...base, report: "", success: false, error: INTERRUPTED_BY_USER };
  }

  updateSubagentState(params.subagentId, {
    agentId: params.agentId,
    conversationId: params.conversationId,
    agentURL: buildAgentReference(params.agentId, {
      conversationId: params.conversationId,
    }),
  });

  const otid = randomUUID();
  const startedAt = Date.now();
  try {
    await sendMessage(params.routing.connectionId, {
      agentId: params.agentId,
      conversationId: params.conversationId,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: params.prompt }],
          client_message_id: randomUUID(),
          otid,
        },
      ],
    });

    const result = await waitForAssistantMessage({
      backend: getBackendFn(),
      agentId: params.agentId,
      conversationId: params.conversationId,
      otid,
      timeoutMs: params.timeoutMs ?? REMOTE_SUBAGENT_TIMEOUT_MS,
      signal: params.signal,
    });

    const failed = result.stopReason === "error";
    return {
      ...base,
      report: result.text,
      success: !failed,
      error: failed
        ? `Remote environment turn stopped with reason: ${result.stopReason}`
        : undefined,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (params.signal?.aborted) {
      return {
        ...base,
        report: "",
        success: false,
        error: INTERRUPTED_BY_USER,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      report: "",
      success: false,
      error: message,
      durationMs: Date.now() - startedAt,
    };
  }
}
