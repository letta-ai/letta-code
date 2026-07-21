import {
  type ChannelModelDisplay,
  formatChannelModelDisplay,
} from "./model-display";
import { getChannelDisplayName } from "./plugin-registry";
import type { ChannelRoute, InboundChannelMessage } from "./types";

export type ChannelStatusContext = {
  adapterRunning: boolean;
  accountConfigured: boolean;
  accountEnabled?: boolean;
  route: ChannelRoute | null;
  activeModel?: ChannelModelDisplay;
};

export function buildChannelStatusMessage(
  msg: InboundChannelMessage,
  context: ChannelStatusContext,
): string {
  let displayName = msg.channel;
  try {
    displayName = getChannelDisplayName(msg.channel);
  } catch {
    // Preserve status output for custom channels whose plugin is unavailable.
  }

  const route = context.route;
  const routeStatus = route
    ? "Connected to a Letta agent conversation."
    : "No route is connected for this chat yet.";
  const accountStatus = !context.accountConfigured
    ? "No channel account is configured for this receiver."
    : context.accountEnabled === false
      ? "Channel account is configured but disabled."
      : "Channel account is configured and enabled.";

  const lines = [
    `${displayName} status`,
    accountStatus,
    `Listener: ${context.adapterRunning ? "running" : "stopped"}.`,
    `Route: ${routeStatus}`,
  ];

  if (context.activeModel) {
    lines.push(`Model: ${formatChannelModelDisplay(context.activeModel)}.`);
  }

  if (route) {
    lines.push(`Agent: ${route.agentId}.`);
    lines.push(`Conversation: ${route.conversationId}.`);
    if (route.threadId) {
      lines.push(`Thread: ${route.threadId}.`);
    }
    if (route.detached) {
      lines.push("Slack thread is detached until the app is mentioned again.");
    } else if (route.outboundEnabled === false) {
      lines.push(
        "Outbound replies are disabled until the app is mentioned again.",
      );
    }
  } else {
    lines.push(
      "Send a normal non-command message here to get pairing or connection instructions.",
    );
  }

  return lines.join("\n");
}
