import type { ControlRequest } from "@/types/protocol_v2";
export async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

export function makeControlRequest(requestId: string): ControlRequest {
  return {
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: {},
      tool_call_id: requestId.replace("perm-", "call-"),
      permission_suggestions: [],
      blocked_path: null,
    },
  };
}
