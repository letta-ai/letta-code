import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import type { ApprovalContext } from "@/permissions/analyzer";
import { analyzeToolApproval, savePermissionRule } from "@/tools/manager";

type Request = {
  toolName: string;
  args: Record<string, unknown>;
  toolCallId: string;
  reason?: string;
  allowPersistence?: boolean;
  signal?: AbortSignal;
};
type Decision = { approved: boolean; args?: Record<string, unknown> };
type Entry = {
  approval: ApprovalRequest;
  args: Record<string, unknown>;
  context: ApprovalContext;
  generation: number;
  conversationId: string;
  toolContextId: string | null;
  signal?: AbortSignal;
  finish: (decision: Decision) => void;
  removeAbortListener?: () => void;
};

/** Host-owned decisions for tool calls made inside a running CodeMode script. */
export function useNestedToolApproval(
  generationRef: React.MutableRefObject<number>,
  conversationIdRef: React.MutableRefObject<string>,
  toolContextIdRef: React.MutableRefObject<string | null>,
) {
  const entries = useRef<Entry[]>([]);
  const [current, setCurrent] = useState<Entry | null>(null);
  const showNext = useCallback(
    () => setCurrent(entries.current[0] ?? null),
    [],
  );
  const valid = useCallback(
    (entry: Entry) =>
      !entry.signal?.aborted &&
      entry.generation === generationRef.current &&
      entry.conversationId === conversationIdRef.current &&
      entry.toolContextId !== null &&
      entry.toolContextId === toolContextIdRef.current,
    [generationRef, conversationIdRef, toolContextIdRef],
  );
  const settle = useCallback(
    (entry: Entry, decision: Decision) => {
      if (!entries.current.includes(entry)) return;
      entries.current = entries.current.filter((item) => item !== entry);
      entry.removeAbortListener?.();
      entry.finish(valid(entry) ? decision : { approved: false });
      showNext();
    },
    [showNext, valid],
  );
  const requestApproval = useCallback(
    async (request: Request): Promise<Decision> => {
      if (request.signal?.aborted) return { approved: false };
      const generation = generationRef.current;
      const conversationId = conversationIdRef.current;
      const toolContextId = toolContextIdRef.current;
      const analyzed = await analyzeToolApproval(
        request.toolName,
        request.args,
      );
      const context =
        request.allowPersistence === false
          ? { ...analyzed, allowPersistence: false }
          : analyzed;
      if (
        request.signal?.aborted ||
        generation !== generationRef.current ||
        conversationId !== conversationIdRef.current ||
        (toolContextId !== null && toolContextIdRef.current !== toolContextId)
      )
        return { approved: false };
      return new Promise<Decision>((resolve) => {
        const entry: Entry = {
          approval: {
            toolCallId: request.toolCallId,
            toolName: request.toolName,
            toolArgs: JSON.stringify(request.args),
          },
          args: request.args,
          context,
          generation,
          conversationId,
          toolContextId,
          signal: request.signal,
          finish: resolve,
        };
        const onAbort = () => settle(entry, { approved: false });
        // Store cleanup on the entry so a decision removes precisely this listener.
        entry.removeAbortListener = () =>
          request.signal?.removeEventListener("abort", onAbort);
        entries.current.push(entry);
        request.signal?.addEventListener("abort", onAbort, { once: true });
        if (request.signal?.aborted) onAbort();
        else showNext();
      });
    },
    [generationRef, conversationIdRef, toolContextIdRef, settle, showNext],
  );
  const decide = useCallback(
    (approved: boolean) => {
      const entry = entries.current[0];
      if (entry)
        settle(entry, { approved, args: approved ? entry.args : undefined });
    },
    [settle],
  );
  const approveAlways = useCallback(
    async (scope: "project" | "session") => {
      const entry = entries.current[0];
      if (!entry || !valid(entry)) {
        if (entry) settle(entry, { approved: false });
        return;
      }
      const latest = await analyzeToolApproval(
        entry.approval.toolName,
        entry.args,
      );
      if (!entries.current.includes(entry) || !valid(entry)) return;
      if (!latest.allowPersistence || !latest.recommendedRule) return;
      try {
        await savePermissionRule(latest.recommendedRule, "allow", scope);
      } catch {
        return; // Keep the question open on persistence failure.
      }
      settle(entry, { approved: true, args: entry.args });
    },
    [settle, valid],
  );
  // Generation changes normally rerender the coordinator; drain stale prompts even
  // if an old tool's abort signal was not forwarded by the executor.
  useEffect(() => {
    for (const entry of [...entries.current]) {
      if (!valid(entry)) settle(entry, { approved: false });
    }
  });
  useEffect(
    () => () => {
      for (const entry of [...entries.current])
        settle(entry, { approved: false });
    },
    [settle],
  );
  return { current, requestApproval, decide, approveAlways };
}
