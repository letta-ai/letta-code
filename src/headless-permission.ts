import type { CanUseToolResponse } from "@/types/protocol";

export type HeadlessPermissionResult = {
  decision: "allow" | "deny";
  reason?: string;
  updatedInput?: Record<string, unknown> | null;
  interrupted?: boolean;
};

interface WaitForHeadlessPermissionResponseOptions {
  requestId: string;
  getNextLine: () => Promise<string | null>;
  restoreDeferredLines: (lines: string[]) => void;
  interruptTurn: () => void;
}

function isCanUseToolResponse(value: unknown): value is CanUseToolResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  return response.behavior === "allow" || response.behavior === "deny";
}

export async function waitForHeadlessPermissionResponse(
  options: WaitForHeadlessPermissionResponseOptions,
): Promise<HeadlessPermissionResult> {
  const deferredLines: string[] = [];

  try {
    while (true) {
      const line = await options.getNextLine();
      if (line === null) {
        return { decision: "deny", reason: "stdin closed" };
      }
      if (!line.trim()) continue;

      let message: {
        type?: string;
        response?: { request_id?: unknown; response?: unknown };
      };
      try {
        message = JSON.parse(line);
      } catch {
        deferredLines.push(line);
        continue;
      }

      if (
        message.type !== "control_response" ||
        message.response?.request_id !== options.requestId
      ) {
        deferredLines.push(line);
        continue;
      }

      const response = message.response.response;
      if (!isCanUseToolResponse(response)) {
        return { decision: "deny", reason: "Invalid response format" };
      }

      if (response.behavior === "allow") {
        return {
          decision: "allow",
          updatedInput: response.updatedInput,
        };
      }

      const interrupted = response.interrupt === true;
      if (interrupted) options.interruptTurn();
      return {
        decision: "deny",
        reason: response.message,
        ...(interrupted ? { interrupted: true } : {}),
      };
    }
  } finally {
    if (deferredLines.length > 0) {
      options.restoreDeferredLines(deferredLines);
    }
  }
}
