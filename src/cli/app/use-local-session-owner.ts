import { useEffect, useRef } from "react";
import { isLocalBackendEnabled } from "@/backend";
import { isLocalAgentId } from "@/cli/helpers/app-urls";
import type { QueueRuntime } from "@/queue/queue-runtime";
import { debugWarn } from "@/utils/debug";
import { startLocalSessionOwner } from "@/websocket/local-session-owner";

export function useLocalSessionOwner(params: {
  agentId: string;
  conversationId: string;
  queueRuntime: QueueRuntime;
  onQueueChanged: () => void;
  onAbort: () => boolean;
  isProcessing: boolean;
}): void {
  const onQueueChangedRef = useRef(params.onQueueChanged);
  const onAbortRef = useRef(params.onAbort);
  const isProcessingRef = useRef(params.isProcessing);
  onQueueChangedRef.current = params.onQueueChanged;
  onAbortRef.current = params.onAbort;
  isProcessingRef.current = params.isProcessing;
  useEffect(() => {
    if (
      isLocalBackendEnabled() ||
      !params.agentId ||
      params.agentId === "loading" ||
      isLocalAgentId(params.agentId)
    ) {
      return;
    }

    let disposed = false;
    let release: (() => Promise<boolean>) | undefined;
    void startLocalSessionOwner({
      agentId: params.agentId,
      conversationId: params.conversationId || "default",
      queueRuntime: params.queueRuntime,
      surfaceName: "TUI",
      onQueueChanged: () => onQueueChangedRef.current(),
      onAbort: () => onAbortRef.current(),
      isProcessing: () => isProcessingRef.current,
      onError: (error) => debugWarn("tui-session-owner", error.message),
    })
      .then((owner) => {
        if (disposed) void owner.release();
        else release = () => owner.release();
      })
      .catch((error: unknown) => {
        debugWarn(
          "tui-session-owner",
          error instanceof Error ? error.message : String(error),
        );
      });

    return () => {
      disposed = true;
      void release?.();
    };
  }, [params.agentId, params.conversationId, params.queueRuntime]);
}
