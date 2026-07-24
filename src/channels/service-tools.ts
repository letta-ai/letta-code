import { refreshDynamicChannelToolsInLoadedRegistry } from "@/tools/manager";

export async function refreshLoadedMessageChannelTool(): Promise<void> {
  await refreshDynamicChannelToolsInLoadedRegistry();
}
