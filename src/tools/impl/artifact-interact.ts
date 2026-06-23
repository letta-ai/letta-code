import { randomUUID } from "node:crypto";
import { getCurrentAgentId } from "@/agent/context";
import { waitForArtifactInteractResponse } from "@/websocket/listener/commands/artifact-interact-requests";
import { getActiveRuntime } from "@/websocket/listener/runtime";

interface ArtifactInteractArgs {
  app_name: string;
  action:
    | "snapshot"
    | "click"
    | "input"
    | "select"
    | "keydown"
    | "submit"
    | "wait_for_selector"
    | "wait_for_text"
    | "wait_for_change"
    | "wait_for_idle";
  selector?: string;
  value?: string;
  text?: string;
  key?: string;
  timeout_ms?: number;
}

function getTimeoutMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 7000;
  return Math.max(1000, Math.min(30000, value));
}

export async function artifact_interact(args: ArtifactInteractArgs): Promise<{
  content: string;
}> {
  const agentId = getCurrentAgentId();
  if (!agentId) {
    throw new Error("artifact_interact: current agent id is unavailable");
  }

  const runtime = getActiveRuntime();
  const socket = runtime?.socket;
  if (!socket || socket.readyState !== 1) {
    throw new Error(
      "artifact_interact: no active connected UI runtime socket is available",
    );
  }

  const requestId = randomUUID();
  const timeoutMs = getTimeoutMs(args.timeout_ms);
  const responsePromise = waitForArtifactInteractResponse({
    requestId,
    timeoutMs: timeoutMs + 2000,
  });

  socket.send(
    JSON.stringify({
      type: "artifact_interact",
      request_id: requestId,
      agent_id: agentId,
      app_name: args.app_name,
      action: args.action,
      selector: args.selector,
      value: args.value,
      text: args.text,
      key: args.key,
      timeout_ms: timeoutMs,
    }),
  );

  const response = await responsePromise;
  return {
    content: JSON.stringify(
      {
        success: response.success,
        app_name: response.app_name,
        action: response.action,
        result: response.result,
        error: response.error,
        logs: response.logs,
      },
      null,
      2,
    ),
  };
}
