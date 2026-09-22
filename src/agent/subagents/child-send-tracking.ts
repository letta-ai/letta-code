import {
  completeSubagent,
  generateSubagentId,
  registerSubagent,
  updateSubagent,
} from "@/agent/subagent-state";
import type { Backend } from "@/backend";
import type { EnqueueReceipt } from "@/backend/api/conversation-enqueue";
import {
  getLatestConversationSuperRun,
  openConversationStatusStream,
} from "@/backend/api/conversation-enqueue";
import { buildAgentReference } from "@/cli/helpers/app-urls";
import { waitForAcceptedSuperRun } from "@/headless-super-run-wait";
import { getErrorMessage } from "@/utils/error";

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
): Promise<unknown> {
  return waitForAcceptedSuperRun(receipt, signal, {
    open: openConversationStatusStream,
    latest: getLatestConversationSuperRun,
    // Only the lifecycle matters here; the reply is never collected.
    messages: async () => [],
  });
}

/**
 * A `SendAgentMessage` to a child subagent is fire-and-forget for the model,
 * but the child is still doing this parent's work. Register it in the parent's
 * subagent state (feeding the TUI group, the listener snapshot, and Cloud's
 * `active_subagent_count`) and follow the enqueue receipt until that specific
 * Super Run settles. Tracking is bound to the receipt, so a later direct chat
 * with the child never keeps the parent's indicator lit.
 *
 * The entry is deliberately not a background subagent. The child runs on its
 * own machine, so the parent has no work of its own to keep alive; Cloud reads
 * `is_background` as a sandbox keep-alive claim and an ownership hold
 * (sandboxActivityClaims, conversationRuntimeStatusResolver), and this entry
 * must light the roster and badges without changing either.
 */
export function trackChildSend(input: TrackChildSendInput): string {
  const { receipt, child, parentScope } = input;
  const subagentId = generateSubagentId();
  registerSubagent(
    subagentId,
    child.type,
    child.name,
    undefined,
    false,
    false,
    parentScope,
    input.prompt,
  );
  updateSubagent(subagentId, {
    agentId: receipt.agent_id,
    conversationId: receipt.conversation_id,
    agentURL: buildAgentReference(receipt.agent_id, {
      conversationId: receipt.conversation_id,
    }),
  });

  void (input.waitForRun ?? waitForChildRun)(
    receipt,
    input.signal ?? new AbortController().signal,
  ).then(
    () => completeSubagent(subagentId, { success: true }),
    (error) =>
      completeSubagent(subagentId, {
        success: false,
        error: getErrorMessage(error),
      }),
  );

  return subagentId;
}
