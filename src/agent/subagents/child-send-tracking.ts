import {
  completeSubagent,
  generateSubagentId,
  registerSubagent,
  updateSubagent,
} from "@/agent/subagent-state";
import { type Backend, getBackend } from "@/backend";
import type { EnqueueReceipt } from "@/backend/api/conversation-enqueue";
import {
  getEnqueueAgentId,
  getExactSuperRun,
  listEnqueuedRunMessages,
} from "@/backend/api/conversation-enqueue";
import { buildAgentReference } from "@/cli/helpers/app-urls";
import {
  readConversationRuntimeStatus,
  waitForAcceptedSuperRun,
} from "@/headless-super-run-wait";
import { getErrorMessage } from "@/utils/error";
import { createRemoteIdleNotifier } from "./remote-turn-wait";

export interface ChildSubagentIdentity {
  name: string;
  /** The `type:<subagent_type>` tag written at spawn, when present. */
  type: string;
}

function readTag(tags: unknown, prefix: string): string | undefined {
  if (!Array.isArray(tags)) return undefined;
  for (const tag of tags) {
    if (typeof tag === "string" && tag.startsWith(prefix)) {
      return tag.slice(prefix.length);
    }
  }
  return undefined;
}

/**
 * Resolves `agentId` as a subagent spawned by `parentAgentId`, or null. Spawned
 * subagents carry a `parent:<id>` tag (see manager.ts); peers messaged over
 * A2A carry no such tag and never enter the parent's subagent state.
 */
export async function resolveChildSubagent(
  backend: Pick<Backend, "retrieveAgent">,
  agentId: string,
  parentAgentId: string,
): Promise<ChildSubagentIdentity | null> {
  try {
    // Cloud omits tags unless asked; without this a tagged child looks like a
    // peer and is silently never tracked (same footgun as memfs-sync.ts).
    const agent = await backend.retrieveAgent(agentId, {
      include: ["agent.tags"],
    });
    if (readTag(agent.tags, "parent:") !== parentAgentId) return null;
    return {
      name: agent.name,
      type: readTag(agent.tags, "type:") ?? "general-purpose",
    };
  } catch {
    return null;
  }
}

export interface TrackChildSendInput {
  receipt: EnqueueReceipt;
  child: ChildSubagentIdentity;
  prompt: string;
  parentScope: { agentId: string; conversationId: string };
  signal?: AbortSignal;
  /** Test seam; follows the Cloud Super Run feed by default. */
  waitForRun?: (
    receipt: EnqueueReceipt,
    signal: AbortSignal,
  ) => Promise<unknown>;
}

function waitForChildRun(
  receipt: EnqueueReceipt,
  signal: AbortSignal,
  onIdle: (text: string, count: number) => void,
): Promise<unknown> {
  const backend = getBackend();
  return waitForAcceptedSuperRun(receipt, signal, {
    exact: getExactSuperRun,
    run: (runId, readSignal) =>
      backend.retrieveRun(runId, { signal: readSignal }),
    messages: listEnqueuedRunMessages,
    runtimeStatus: readConversationRuntimeStatus,
    onIdle,
  });
}

/**
 * A `SendAgentMessage` to a child subagent is fire-and-forget for the model,
 * but the child is still doing this parent's work. Register it in the parent's
 * subagent state (feeding the TUI group, the listener snapshot, and Cloud's
 * `active_subagent_count`) and follow the enqueue receipt until that specific
 * Super Run settles. Tracking is bound to the receipt, so a later direct chat
 * with the child never keeps the parent's indicator lit.
 */
export function trackChildSend(input: TrackChildSendInput): string {
  const { receipt, child, parentScope } = input;
  const subagentId = generateSubagentId();
  // Keep background TUI grouping, but do not retain the parent runtime for work
  // executing in the child's own Super Run.
  registerSubagent(
    subagentId,
    child.type,
    child.name,
    undefined,
    true,
    false,
    parentScope,
    input.prompt,
    false,
  );
  updateSubagent(subagentId, {
    agentId: receipt.agent_id ?? undefined,
    conversationId: receipt.conversation_id,
    superRunId: receipt.super_run_id,
    // An agentless conversation may report neither agent nor parent agent.
    agentURL:
      receipt.agent_id || receipt.parent_agent_id
        ? buildAgentReference(getEnqueueAgentId(receipt), {
            conversationId: receipt.conversation_id,
          })
        : null,
  });

  const onIdle = createRemoteIdleNotifier(subagentId, parentScope);
  void (
    input.waitForRun ??
    ((receipt, signal) => waitForChildRun(receipt, signal, onIdle))
  )(receipt, input.signal ?? new AbortController().signal).then(
    () => completeSubagent(subagentId, { success: true }),
    (error) =>
      completeSubagent(subagentId, {
        success: false,
        error: getErrorMessage(error),
      }),
  );

  return subagentId;
}
