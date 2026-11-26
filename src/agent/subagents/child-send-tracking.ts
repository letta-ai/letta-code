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
import type { resumeSubagentWriter } from "@/backend/api/subagents";
import { buildAgentReference } from "@/cli/helpers/app-urls";
import {
  readConversationRuntimeStatus,
  waitForAcceptedSuperRun,
} from "@/headless-super-run-wait";
import { getErrorMessage } from "@/utils/error";
import { createRemoteIdleNotifier } from "./remote-turn-wait";

export interface ChildSubagentIdentity {
  name: string;
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
      type: readTag(agent.tags, "type:") ?? "general-purpose",
    };
  } catch {
    return null;
  }
}

export interface TrackChildSendInput {
  receipt: EnqueueReceipt;
  child: ChildSubagentIdentity;
  persistRun?: (change: { status: "completed" | "failed" }) => void;
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

export function trackPersistedChildSend(
  receipt: EnqueueReceipt,
  writer: NonNullable<ReturnType<typeof resumeSubagentWriter>>,
): void {
  void writer.found.then(async (found) => {
    if (!found) return;
    try {
      await waitForChildRun(
        receipt,
        new AbortController().signal,
        () => undefined,
      );
      writer.update({ status: "completed" });
    } catch {
      writer.update({ status: "failed" });
    }
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
    () => {
      input.persistRun?.({ status: "completed" });
      completeSubagent(subagentId, { success: true });
    },
    (error) => {
      input.persistRun?.({ status: "failed" });
      completeSubagent(subagentId, {
        success: false,
        error: getErrorMessage(error),
      });
    },
  );

  return subagentId;
}
