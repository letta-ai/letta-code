import type { ChannelConfigSchema } from "@/channels/plugin-types";

export const FEISHU_CONFIG_SCHEMA: ChannelConfigSchema = {
  version: 1,
  fields: [
    {
      type: "text",
      key: "app_id",
      label: "App ID",
      required: true,
      scope: "account",
      placeholder: "cli_...",
      description:
        "Feishu / Lark Open Platform App ID. Create a self-built app; store apps cannot use persistent connection.",
      restartRequired: true,
    },
    {
      type: "secret",
      key: "app_secret",
      label: "App Secret",
      required: true,
      scope: "account",
      placeholder: "App Secret",
      description: "Open Platform App Secret for this self-built app.",
      restartRequired: true,
    },
    {
      type: "select",
      key: "domain",
      label: "Platform",
      scope: "account",
      default: "feishu",
      options: [
        { value: "feishu", label: "Feishu (open.feishu.cn)" },
        { value: "lark", label: "Lark (open.larksuite.com)" },
      ],
      description:
        "Feishu is the China console and API domain. Lark is the international console. Using the wrong domain fails authentication.",
      restartRequired: true,
    },
    {
      type: "select",
      key: "group_mode",
      label: "Group mode",
      scope: "account",
      default: "mention-only",
      options: [
        {
          value: "mention-only",
          label: "Mention only — respond when @mentioned",
        },
        { value: "open", label: "Open — respond to every group message" },
      ],
      description:
        "Default mention-only matches Feishu's default group @bot scope. Open mode also needs the all-group-messages event scope on the app.",
      restartRequired: true,
    },
    {
      type: "text",
      key: "agent_id",
      label: "Agent ID",
      scope: "account",
      placeholder: "agent-...",
      description:
        "Letta agent this bot represents for DMs (when not pairing) and group @mentions.",
    },
  ],
};
