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
  isSubagent?: true;
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

export async function resolveChildSubagent(
  backend: Pick<Backend, "retrieveAgent">,
  agentId: string,
  parentAgentId: string,
): Promise<ChildSubagentIdentity | null> {
  try {
    const agent = await backend.retrieveAgent(agentId, {
      include: ["agent.tags"],
    });
    if (readTag(agent.tags, "parent:") !== parentAgentId) return null;
    return {
      name: agent.name,
      ...(readTag(agent.tags, "role:") === "subagent"
        ? { isSubagent: true as const }
        : {}),
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

export function trackChildSend(input: TrackChildSendInput): string {
  const { receipt, child, parentScope } = input;
  const subagentId = generateSubagentId();
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
    agentURL: buildAgentReference(getEnqueueAgentId(receipt), {
      conversationId: receipt.conversation_id,
    }),
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
