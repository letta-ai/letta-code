import { useEffect, useRef } from "react";
import { getRuntimeLastEnvironment } from "@/backend/api/environments";
import { isLocalAgentId } from "@/cli/helpers/app-urls";
import type { CloudConversationState } from "./submit-cloud-command";
import type { AppLoadingState } from "./types";

export function useCloudTarget(
  agentId: string,
  conversationId: string,
  loadingState: AppLoadingState,
) {
  const keysRef = useRef<Map<string, CloudConversationState>>(new Map());

  useEffect(() => {
    if (loadingState !== "ready" || isLocalAgentId(agentId)) return;
    let cancelled = false;
    void getRuntimeLastEnvironment(agentId, conversationId)
      .then((environment) => {
        if (!cancelled && environment.source === "sandbox") {
          keysRef.current.set(`${agentId}:${conversationId}`, {});
        }
      })
      .catch(() => {
        // No persisted execution target yet, or this server predates the API.
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, conversationId, loadingState]);

  return keysRef;
}
