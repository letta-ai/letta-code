import { settingsManager } from "@/settings-manager";
import { TOOLSET_OPTIONS } from "@/tools/toolset-options";
import type { DeviceStatus, ToolsetPreference } from "@/types/protocol_v2";
import type { ConversationRuntime } from "./types";

type DeviceToolsetStatus = Pick<
  DeviceStatus,
  "current_toolset" | "current_toolset_preference" | "available_toolsets"
>;

export function buildDeviceToolsetStatus(
  agentId: string | null,
  conversationId: string | null,
  conversationRuntime?: ConversationRuntime | null,
): DeviceToolsetStatus {
  let preference: ToolsetPreference = "auto";
  if (agentId) {
    try {
      preference = settingsManager.getToolsetPreference(
        agentId,
        conversationId ?? "default",
      );
    } catch {
      // Settings may not be initialized while the listener is starting.
    }
  }

  return {
    current_toolset:
      conversationRuntime?.currentToolset ??
      (preference === "auto" ? null : preference),
    current_toolset_preference:
      conversationRuntime?.currentToolset === null
        ? preference
        : (conversationRuntime?.currentToolsetPreference ?? preference),
    available_toolsets: [...TOOLSET_OPTIONS],
  };
}
