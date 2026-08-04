import { describe, expect, test } from "bun:test";

import { listChannelSlashCommands } from "@/channels/commands";
import {
  buildSlackAppManifest,
  listSlackNativeSlashCommands,
  SLACK_APP_MANIFEST_BOT_EVENTS,
  SLACK_APP_MANIFEST_BOT_SCOPES,
  SLACK_APP_MANIFEST_SOURCE_PATH,
} from "@/channels/slack/manifest";

/**
 * These tests verify that the Slack setup helper and the generated app manifest
 * stay consistent. The setup prints scope, event, and slash-command guidance
 * derived from the same manifest constants so users cannot drift between what
 * they configure and what the adapter expects.
 */
describe("Slack setup and manifest consistency", () => {
  test("manifest bot scopes include every scope the setup recommends", () => {
    // The setup helper joins SLACK_APP_MANIFEST_BOT_SCOPES into a single
    // comma-separated string. Verify the manifest builder produces the same
    // list so they cannot drift.
    const manifestScopes = buildSlackAppManifest().oauth_config.scopes.bot;
    expect(manifestScopes).toEqual([...SLACK_APP_MANIFEST_BOT_SCOPES]);
  });

  test("manifest bot events match the events the setup recommends", () => {
    const manifestEvents =
      buildSlackAppManifest().settings.event_subscriptions.bot_events;
    expect(manifestEvents).toEqual([...SLACK_APP_MANIFEST_BOT_EVENTS]);
  });

  test("setup slash commands match the manifest slash commands", () => {
    const setupCommands = listSlackNativeSlashCommands().map(
      (definition) => definition.command,
    );
    const manifestCommands =
      buildSlackAppManifest().features.slash_commands.map(
        (entry) => entry.command,
      );
    expect(setupCommands).toEqual(manifestCommands);
  });

  test("setup and manifest both derive commands from the shared channel command registry", () => {
    const registryCommands = listChannelSlashCommands().flatMap((definition) =>
      [definition.name, ...(definition.aliases ?? [])].map(
        (name) => `/${name}` as `/${string}`,
      ),
    );

    const manifestCommands =
      buildSlackAppManifest().features.slash_commands.map(
        (entry) => entry.command,
      );

    expect(manifestCommands).toEqual(registryCommands);
  });

  test("manifest source path constant points to the manifest module", () => {
    expect(SLACK_APP_MANIFEST_SOURCE_PATH).toBe(
      "src/channels/slack/manifest.ts",
    );
  });
});
