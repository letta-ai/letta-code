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

  test("includes scopes required by current adapter behavior", () => {
    const scopes = buildSlackAppManifest().oauth_config.scopes.bot;

    // assistant:write — assistant.threads.setStatus (status-controller.ts)
    expect(scopes).toContain("assistant:write");

    // channels:read — conversations.list public channels (target-resolution.ts)
    expect(scopes).toContain("channels:read");

    // groups:read — conversations.list private channels (target-resolution.ts)
    expect(scopes).toContain("groups:read");

    // im:write — conversations.open (target-resolution.ts)
    expect(scopes).toContain("im:write");

    // Existing scopes from the original manifest
    expect(scopes).toContain("app_mentions:read");
    expect(scopes).toContain("channels:history");
    expect(scopes).toContain("chat:write");
    expect(scopes).toContain("files:read");
    expect(scopes).toContain("files:write");
    expect(scopes).toContain("groups:history");
    expect(scopes).toContain("im:history");
    expect(scopes).toContain("groups:read");
    expect(scopes).toContain("reactions:read");
    expect(scopes).toContain("reactions:write");
    expect(scopes).toContain("users:read");
  });

  test("declares event subscriptions for inbound Slack messages and reactions", () => {
    const events =
      buildSlackAppManifest().settings.event_subscriptions.bot_events;

    expect(events).toContain("app_mention");
    expect(events).toContain("message.channels");
    expect(events).toContain("message.groups");
    expect(events).toContain("message.im");
    expect(events).toContain("reaction_added");
    expect(events).toContain("reaction_removed");
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

  test("slash command descriptions match the channel command registry summaries", () => {
    const commands = listSlackNativeSlashCommands();
    const registryByName = new Map(
      listChannelSlashCommands().flatMap((definition) =>
        [definition.name, ...(definition.aliases ?? [])].map((name) => [
          name,
          definition,
        ]),
      ),
    );

    for (const spec of commands) {
      const name = spec.command.slice(1);
      const definition = registryByName.get(name);
      expect(definition).toBeDefined();
      expect(spec.description).toBe(definition?.summary ?? "");
    }
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

  test("does not expose credentials or tokens in the manifest", () => {
    const manifest = buildSlackAppManifest();
    const serialized = JSON.stringify(manifest);

    expect(serialized).not.toContain("xoxb-");
    expect(serialized).not.toContain("xapp-");
  });
});
