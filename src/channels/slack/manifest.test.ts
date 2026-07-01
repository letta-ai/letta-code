import { describe, expect, test } from "bun:test";

import { listChannelSlashCommands } from "@/channels/commands";
import {
  buildSlackAppManifest,
  buildSlackAppManifestSlashCommands,
  listSlackNativeSlashCommands,
  SLACK_APP_MANIFEST_BOT_EVENTS,
  SLACK_APP_MANIFEST_BOT_SCOPES,
  SLACK_APP_MANIFEST_COMMAND_URL_PLACEHOLDER,
} from "@/channels/slack/manifest";

function expectedNativeSlackSlashCommands(): `/${string}`[] {
  return listChannelSlashCommands().flatMap((definition) =>
    [definition.name, ...(definition.aliases ?? [])].map(
      (name) => `/${name}` as `/${string}`,
    ),
  );
}

describe("Slack app manifest", () => {
  test("declares Socket Mode settings, events, and bot scopes", () => {
    const manifest = buildSlackAppManifest();

    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.interactivity.is_enabled).toBe(true);
    expect(manifest.features.app_home.home_tab_enabled).toBe(false);
    expect(manifest.features.app_home.messages_tab_enabled).toBe(true);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual([
      ...SLACK_APP_MANIFEST_BOT_EVENTS,
    ]);
    expect(manifest.oauth_config.scopes.bot).toEqual([
      ...SLACK_APP_MANIFEST_BOT_SCOPES,
    ]);
    expect(manifest.oauth_config.scopes.bot).toContain("commands");
  });

  test("generates native Slack slash commands from the channel command registry", () => {
    const manifest = buildSlackAppManifest();
    const manifestCommands = manifest.features.slash_commands.map(
      (entry) => entry.command,
    );

    expect(manifestCommands).toEqual(expectedNativeSlackSlashCommands());
    expect(manifestCommands).toContain("/cancel");
    expect(manifestCommands).toContain("/model");
    expect(manifestCommands).toContain("/reflection");
    expect(manifestCommands).toContain("/reflect");
    expect(
      listSlackNativeSlashCommands().map((entry) => entry.command),
    ).toEqual(manifestCommands);
  });

  test("uses Socket Mode slash command URLs required by Slack manifests", () => {
    const manifest = buildSlackAppManifest();

    expect(
      manifest.features.slash_commands.every(
        (entry) => entry.url === SLACK_APP_MANIFEST_COMMAND_URL_PLACEHOLDER,
      ),
    ).toBe(true);
    expect(
      manifest.features.slash_commands.every(
        (entry) => entry.should_escape === false,
      ),
    ).toBe(true);
    expect(
      manifest.features.slash_commands.every(
        (entry) => entry.usage_hint === "",
      ),
    ).toBe(true);

    const commandUrl = "https://hooks.example.test/slack/commands";
    expect(
      buildSlackAppManifestSlashCommands(commandUrl).every(
        (entry) => entry.url === commandUrl,
      ),
    ).toBe(true);
  });
});
