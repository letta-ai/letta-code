// Analytics labels only: never use rendered notification text for authorization.
// Keep custom channel IDs and arbitrary tool arguments out of analytics.
export function telemetryChannel(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return [
    "slack",
    "microsoftTeams",
    "telegram",
    "discord",
    "whatsapp",
    "signal",
    "imessage",
    "custom",
  ].includes(value)
    ? value
    : "other";
}

export function extractInputChannel(input: string): string | undefined {
  // Match the same channel-notification source rendered in the transcript,
  // excluding fenced/inline examples. A batch still counts as one user input.
  const text = input.replace(/(```|~~~)[\s\S]*?\1/g, "");
  const channels = new Set<string>();
  for (const match of text.matchAll(
    /(?:^|\n)\s*<channel-notification\s+([^>]*)>[\s\S]*?<\/channel-notification>/g,
  )) {
    const source = /(?:^|\s)source=["']([^"']+)["']/.exec(match[1] ?? "");
    const channel = telemetryChannel(source?.[1]);
    if (channel) channels.add(channel);
  }
  return channels.size > 1 ? "mixed" : channels.values().next().value;
}

export function messageChannelTelemetry(input: Record<string, unknown>): {
  channel?: string;
  channel_action?: string;
} {
  const action = input.action;
  return {
    channel: telemetryChannel(input.channel),
    channel_action:
      typeof action === "string"
        ? ["send", "react", "upload-file"].includes(action)
          ? action
          : "other"
        : undefined,
  };
}
