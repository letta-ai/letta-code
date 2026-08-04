import { listChannelSlashCommands } from "@/channels/commands";

export const SLACK_APP_MANIFEST_SOURCE_PATH = "src/channels/slack/manifest.ts";
export const SLACK_APP_MANIFEST_COMMAND_URL_PLACEHOLDER =
  "https://example.com/slack/commands";

export const SLACK_APP_MANIFEST_BOT_SCOPES = [
  "app_mentions:read",
  "assistant:write",
  "channels:history",
  "channels:read",
  "chat:write",
  "commands",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:write",
  "reactions:read",
  "reactions:write",
  "users:read",
] as const;

export const SLACK_APP_MANIFEST_BOT_EVENTS = [
  "app_mention",
  "message.channels",
  "message.groups",
  "message.im",
  "reaction_added",
  "reaction_removed",
] as const;

export type SlackNativeSlashCommandSpec = {
  command: `/${string}`;
  description: string;
};

export type SlackAppManifestSlashCommand = SlackNativeSlashCommandSpec & {
  url: string;
  usage_hint: string;
  should_escape: boolean;
};

export type SlackAppManifest = {
  display_information: {
    name: string;
    description: string;
    background_color: string;
  };
  features: {
    app_home: {
      home_tab_enabled: boolean;
      messages_tab_enabled: boolean;
      messages_tab_read_only_enabled: boolean;
    };
    bot_user: {
      display_name: string;
      always_online: boolean;
    };
    slash_commands: SlackAppManifestSlashCommand[];
  };
  oauth_config: {
    scopes: {
      bot: string[];
    };
  };
  settings: {
    event_subscriptions: {
      bot_events: string[];
    };
    interactivity: {
      is_enabled: boolean;
    };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
};

export type SlackAppManifestOptions = {
  /**
   * Slack app manifests require a slash-command URL even when Socket Mode
   * delivers the payload over the app-level WebSocket. Keep the placeholder for
   * local Socket Mode apps, or replace it with a workspace-specific HTTPS URL
   * if the app is later served over HTTP.
   */
  commandUrl?: string;
};

export function listSlackNativeSlashCommands(): SlackNativeSlashCommandSpec[] {
  return listChannelSlashCommands().flatMap((definition) =>
    [definition.name, ...(definition.aliases ?? [])].map((name) => ({
      command: `/${name}` as `/${string}`,
      description: definition.summary,
    })),
  );
}

export function buildSlackAppManifestSlashCommands(
  commandUrl = SLACK_APP_MANIFEST_COMMAND_URL_PLACEHOLDER,
): SlackAppManifestSlashCommand[] {
  return listSlackNativeSlashCommands().map((definition) => ({
    ...definition,
    url: commandUrl,
    usage_hint: "",
    should_escape: false,
  }));
}

export function buildSlackAppManifest(
  options: SlackAppManifestOptions = {},
): SlackAppManifest {
  const commandUrl =
    options.commandUrl ?? SLACK_APP_MANIFEST_COMMAND_URL_PLACEHOLDER;

  return {
    display_information: {
      name: "Letta Code",
      description: "Connect Letta Code agents to Slack.",
      background_color: "#1d1c1d",
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: "Letta Code",
        always_online: false,
      },
      slash_commands: buildSlackAppManifestSlashCommands(commandUrl),
    },
    oauth_config: {
      scopes: {
        bot: [...SLACK_APP_MANIFEST_BOT_SCOPES],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: [...SLACK_APP_MANIFEST_BOT_EVENTS],
      },
      interactivity: {
        is_enabled: true,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}
