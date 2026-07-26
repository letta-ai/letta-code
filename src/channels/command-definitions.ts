export type ChannelSlashCommandKind = "direct" | "agent-scoped";

export type ChannelSlashCommandDefinition = {
  name: string;
  aliases?: string[];
  kind: ChannelSlashCommandKind;
  summary: string;
};

export const CHANNEL_SLASH_COMMANDS: ChannelSlashCommandDefinition[] = [
  { name: "help", kind: "direct", summary: "Show channel usage guidance." },
  {
    name: "status",
    kind: "direct",
    summary: "Show this chat's channel connection status.",
  },
  {
    name: "whoami",
    kind: "direct",
    summary: "Show your access tier and runnable commands here.",
  },
  {
    name: "pause",
    kind: "direct",
    summary: "Pause agent routing for this chat.",
  },
  {
    name: "resume",
    kind: "direct",
    summary: "Resume agent routing for this chat.",
  },
  {
    name: "cancel",
    kind: "agent-scoped",
    summary: "Cancel the in-progress agent turn for this chat.",
  },
  {
    name: "chat",
    kind: "direct",
    summary: "Show the Letta web chat link for this channel route.",
  },
  {
    name: "feedback",
    kind: "direct",
    summary: "Send feedback about Letta Code from this routed chat.",
  },
  {
    name: "compact",
    kind: "agent-scoped",
    summary: "Compact this chat's routed conversation.",
  },
  { name: "context", kind: "agent-scoped", summary: "Show context usage." },
  {
    name: "conv",
    kind: "agent-scoped",
    summary: "Manage this chat's routed conversation.",
  },
  {
    name: "model",
    kind: "agent-scoped",
    summary:
      "Show, list, or switch the model for this chat's routed conversation.",
  },
  {
    name: "reflection",
    aliases: ["reflect"],
    kind: "agent-scoped",
    summary: "Start a memory reflection pass for this conversation.",
  },
];

export const SLACK_NATIVE_SLASH_COMMAND_NAMES = ["cancel"] as const;

export const SLACK_MENTION_COMMAND_NAMES = [
  "help",
  "detach",
  "model",
  "new",
  "reload",
] as const;

export const SLACK_MENTION_SLASH_COMMAND_EXAMPLES = [
  "@agent /help",
  "@agent /status",
  "@agent /whoami",
  "@agent /model",
  "@agent /model list",
  "@agent /model <handle-or-id>",
  "@agent /context",
  "@agent /compact",
  "@agent /conv",
  "@agent /cancel",
  "@agent /chat",
  "@agent /feedback <message>",
  "@agent /reflection",
  "@agent /detach",
  "@agent /new",
  "@agent /reload",
] as const;
