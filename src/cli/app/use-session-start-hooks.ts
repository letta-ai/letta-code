import { type MutableRefObject, useEffect, useRef } from "react";
import { runSessionStartHooks } from "@/hooks";
import { debugWarn } from "@/utils/debug";

type SessionStartContext = {
  agentId: string;
  agentName: string | null;
  conversationId: string;
  commandRunning: boolean;
  isNewSessionRef: MutableRefObject<boolean>;
  feedbackRef: MutableRefObject<string[]>;
};

export function useSessionStartHooks(
  ctx: SessionStartContext,
  runHooks: typeof runSessionStartHooks = runSessionStartHooks,
): void {
  const {
    agentId,
    agentName,
    conversationId,
    commandRunning,
    isNewSessionRef,
    feedbackRef,
  } = ctx;
  const lastSessionRef = useRef<{
    agentId: string;
    conversationId: string;
  } | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    // 等待切换命令完成，避免把尚未配对的 agent 和会话上报给外部集成。
    if (!agentId || agentId === "loading" || commandRunning) return;
    const lastSession = lastSessionRef.current;
    if (
      lastSession?.agentId === agentId &&
      lastSession.conversationId === conversationId
    )
      return;

    lastSessionRef.current = { agentId, conversationId };
    const generation = ++generationRef.current;
    const isNewSession = isNewSessionRef.current;
    isNewSessionRef.current = false;
    feedbackRef.current = [];

    void runHooks(isNewSession, agentId, agentName ?? undefined, conversationId)
      .then((result) => {
        // 即使用户切回同一个会话，也不能接收上一次打开该会话时的迟到结果。
        if (generationRef.current === generation)
          feedbackRef.current = result.feedback;
      })
      .catch((error: unknown) => {
        debugWarn("hooks", "SessionStart failed: %s", error);
      });
  }, [
    agentId,
    agentName,
    conversationId,
    commandRunning,
    isNewSessionRef,
    feedbackRef,
    runHooks,
  ]);
}
