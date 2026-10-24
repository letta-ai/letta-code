import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import {
  getResumeDataFromBackend,
  type ResumeData,
} from "@/agent/check-approval";
import { STALE_APPROVAL_RECOVERY_DENIAL_REASON } from "@/agent/turn-recovery-policy";
import { getBackend } from "@/backend";

type Input = Array<MessageCreate | ApprovalCreate>;
type Pending = ResumeData["pendingApprovals"];
type ReadDependencies = {
  readPending?: (signal: AbortSignal) => Promise<Pending>;
  timeoutMs?: number;
};

async function readPendingWithDeadline(
  agentId: string,
  conversationId: string,
  signal: AbortSignal | undefined,
  deps: ReadDependencies,
): Promise<Pending> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error("Automatic approval pending-state read timed out"),
      ),
    deps.timeoutMs ?? 30_000,
  );
  let rejectInterrupted!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupted = reject;
  });
  const onInterrupted = () => rejectInterrupted(controller.signal.reason);
  controller.signal.addEventListener("abort", onInterrupted, { once: true });
  const readPending =
    deps.readPending ??
    (async (readSignal: AbortSignal) => {
      const agent = await getBackend().retrieveAgent(agentId, undefined, {
        signal: readSignal,
        maxRetries: 0,
      });
      readSignal.throwIfAborted();
      return (
        await getResumeDataFromBackend(agent, conversationId, {
          includeMessageHistory: false,
          throwOnReadError: true,
          signal: readSignal,
        })
      ).pendingApprovals;
    });
  try {
    signal?.throwIfAborted();
    const pending = await Promise.race([
      readPending(controller.signal),
      interrupted,
    ]);
    controller.signal.throwIfAborted();
    return pending;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    controller.signal.removeEventListener("abort", onInterrupted);
  }
}

export class AutomaticApprovalRetryChangedError extends Error {
  constructor(
    readonly pendingApprovals: Pending,
    readonly action: "show_pending" | "stop",
  ) {
    super(
      "Automatic approval recovery stopped because pending tool calls changed. Refresh the conversation before continuing.",
    );
    this.name = "AutomaticApprovalRetryChangedError";
  }
}

export async function reconcileAutomaticApprovalRetry(
  agentId: string,
  conversationId: string,
  input: Input,
  signal?: AbortSignal,
  deps: ReadDependencies = {},
): Promise<Input> {
  signal?.throwIfAborted();
  const approvals = input.flatMap((item) =>
    item.type === "approval" ? (item.approvals ?? []) : [],
  );
  const automatic = approvals.filter(
    (approval) =>
      approval.type === "approval" &&
      approval.approve === false &&
      approval.reason === STALE_APPROVAL_RECOVERY_DENIAL_REASON,
  );
  if (automatic.length === 0) return input;
  const pending = await readPendingWithDeadline(
    agentId,
    conversationId,
    signal,
    deps,
  );
  signal?.throwIfAborted();
  const expected = new Set(pending.map((approval) => approval.toolCallId));
  const submitted = approvals.map((approval) => approval.tool_call_id);
  if (
    submitted.length === expected.size &&
    submitted.every((id) => expected.has(id)) &&
    new Set(submitted).size === submitted.length
  )
    return input;
  const onlyAutomatic = automatic.length === approvals.length;
  if (pending.length === 0 && onlyAutomatic) {
    const messages = input.filter((item) => item.type !== "approval");
    if (messages.length > 0) return messages;
  }
  throw new AutomaticApprovalRetryChangedError(
    pending,
    onlyAutomatic && pending.length > 0 ? "show_pending" : "stop",
  );
}
