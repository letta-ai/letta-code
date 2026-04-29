import { describe, expect, test } from "bun:test";

const { buildPairingInstructions, buildUnboundRouteInstructions } =
  await import("../../channels/registry");

describe("registry copy: first-party channels", () => {
  test("pairing instructions point at the desktop UI for telegram", () => {
    const text = buildPairingInstructions("telegram", "ABC123");
    expect(text).toContain("open Channels >");
    expect(text).toContain("Telegram");
    expect(text).toContain("Pairing code: ABC123");
    expect(text).not.toContain("letta channels pair approve");
    expect(text).not.toContain("(community channel)");
  });

  test("unbound route instructions point at the desktop UI for slack", () => {
    const text = buildUnboundRouteInstructions("slack", "C123ABC");
    expect(text).toContain("Open Channels >");
    expect(text).toContain("Slack");
    expect(text).toContain("Chat ID: C123ABC");
    expect(text).not.toContain("letta channels route add");
    expect(text).not.toContain("(community channel)");
  });

  test("first-party discord pairing keeps the desktop wording", () => {
    const text = buildPairingInstructions("discord", "XYZ789");
    expect(text).toContain("open Channels >");
    expect(text).toContain("Discord");
  });
});

describe("registry copy: community channels", () => {
  // Any channel id that isn't telegram/slack/discord is a community plugin.
  // We don't need a real plugin installed — `isFirstPartyChannelPlugin` only
  // checks the FIRST_PARTY_CHANNEL_PLUGIN_REGISTRATIONS map.

  test("pairing instructions surface the CLI command for community channels", () => {
    const text = buildPairingInstructions("whatsapp", "ABC123");
    expect(text).toContain("(community channel)");
    expect(text).toContain("Pairing code: ABC123");
    expect(text).toContain(
      "letta channels pair approve --channel whatsapp --code ABC123",
    );
    expect(text).not.toContain("open Channels >");
  });

  test("unbound route instructions surface the CLI command for community channels", () => {
    const text = buildUnboundRouteInstructions(
      "whatsapp",
      "15551234567@s.whatsapp.net",
    );
    expect(text).toContain("(community channel)");
    expect(text).toContain(
      "letta channels route add --channel whatsapp --chat-id 15551234567@s.whatsapp.net --agent <agent-id>",
    );
    expect(text).toContain("~/.letta/channels/whatsapp/routing.yaml");
    expect(text).not.toContain("Open Channels >");
  });

  test("any non-first-party channel id triggers community copy", () => {
    const text = buildPairingInstructions("imessage", "QQQ");
    expect(text).toContain("(community channel)");
    expect(text).toContain(
      "letta channels pair approve --channel imessage --code QQQ",
    );
  });

  test("community unbound copy embeds the channel id in both the CLI hint and the path", () => {
    const text = buildUnboundRouteInstructions("signal", "+15551234567");
    expect(text).toContain("--channel signal");
    expect(text).toContain("--chat-id +15551234567");
    expect(text).toContain("~/.letta/channels/signal/routing.yaml");
  });
});
