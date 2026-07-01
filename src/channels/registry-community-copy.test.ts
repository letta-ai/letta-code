import { describe, expect, test } from "bun:test";
import { buildChannelHelpMessage } from "@/channels/commands";

const { buildPairingInstructions, buildUnboundRouteInstructions } =
  await import("@/channels/registry");

describe("registry copy: first-party channels", () => {
  test("pairing instructions point at both desktop UI and CLI for telegram", () => {
    const text = buildPairingInstructions("telegram", "ABC123");
    expect(text).toContain("Connect this chat to a Letta agent.");
    expect(text).toContain("In Letta Code: open Channels > Telegram");
    expect(text).toContain("Telegram");
    expect(text).toContain("Pairing code: ABC123");
    expect(text).toContain("CLI on the listener machine:");
    expect(text).toContain(
      "letta channels pair --channel telegram --code ABC123 --agent <agent-id>",
    );
    expect(text).toContain("Find the target agent with: letta agents list");
    expect(text).toContain("This code expires in 15 minutes.");
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

  test("first-party discord pairing uses a configured agent in the CLI command", () => {
    const text = buildPairingInstructions("discord", "XYZ789", {
      agentId: "agent-discord",
    });
    expect(text).toContain("In Letta Code: open Channels > Discord");
    expect(text).toContain("Discord");
    expect(text).toContain(
      "letta channels pair --channel discord --code XYZ789 --agent agent-discord",
    );
    expect(text).not.toContain("--agent <agent-id>");
    expect(text).not.toContain("Find the target agent with: letta agents list");
  });

  test("first-party whatsapp pairing includes the desktop and CLI paths", () => {
    const text = buildPairingInstructions("whatsapp", "W123", {
      agentId: "agent-whatsapp",
    });
    expect(text).toContain("In Letta Code: open Channels > WhatsApp");
    expect(text).toContain("WhatsApp");
    expect(text).toContain("Pairing code: W123");
    expect(text).toContain(
      "letta channels pair --channel whatsapp --code W123 --agent agent-whatsapp",
    );
    expect(text).not.toContain("--agent <agent-id>");
  });

  test("first-party whatsapp unbound route keeps the desktop wording", () => {
    const text = buildUnboundRouteInstructions(
      "whatsapp",
      "15551234567@s.whatsapp.net",
    );
    expect(text).toContain("Open Channels >");
    expect(text).toContain("WhatsApp");
    expect(text).toContain("Chat ID: 15551234567@s.whatsapp.net");
    expect(text).not.toContain("letta channels route add");
  });

  test("first-party copy uses 'Letta agent' consistently", () => {
    expect(buildPairingInstructions("telegram", "X")).toContain("Letta agent");
    expect(buildUnboundRouteInstructions("slack", "Y")).toContain(
      "Letta agent",
    );
    expect(buildPairingInstructions("telegram", "X")).not.toContain(
      "Letta Code agent",
    );
  });

  test("channel help explains how to use a connected Telegram chat", () => {
    const text = buildChannelHelpMessage("telegram");
    expect(text).toContain("Telegram is connected to Letta Code.");
    expect(text).toContain("Send a normal message");
    expect(text).toContain("connected agent will reply in this chat");
    expect(text).not.toContain("MessageChannel");
    expect(text).not.toContain("open Channels >");
  });
});

describe("registry copy: community channels", () => {
  // Any channel id that isn't telegram/slack/discord/whatsapp/signal is a community plugin.
  // We don't need a real plugin installed — `isFirstPartyChannelPlugin` only
  // checks the FIRST_PARTY_CHANNEL_PLUGIN_REGISTRATIONS map.

  test("pairing instructions surface the CLI command for community channels", () => {
    const text = buildPairingInstructions("custom-chat", "ABC123");
    expect(text).toContain("Connect this chat to a Letta agent.");
    expect(text).toContain("Pairing code: ABC123");
    expect(text).toContain("CLI on the listener machine:");
    expect(text).toContain(
      "letta channels pair --channel custom-chat --code ABC123 --agent <agent-id>",
    );
    expect(text).toContain("Find the target agent with: letta agents list");
    expect(text).toContain("This code expires in 15 minutes.");
    expect(text).not.toContain("open Channels >");
    expect(text).not.toContain("(community channel)");
    // Hard-stop against shipping the wrong subcommand again.
    expect(text).not.toContain("letta channels pair approve");
  });

  test("unbound route instructions surface the CLI command for community channels", () => {
    const text = buildUnboundRouteInstructions("custom-chat", "chat-123");
    expect(text).toContain("isn't connected to a Letta agent yet");
    expect(text).toContain("On the machine where your listener runs");
    expect(text).toContain(
      "letta channels route add --channel custom-chat --chat-id chat-123 --agent <agent-id>",
    );
    expect(text).toContain("Find your agent id with letta agents list.");
    expect(text).not.toContain("Open Channels >");
    expect(text).not.toContain("(community channel)");
    expect(text).not.toContain("paste a route");
    expect(text).not.toContain("routing.yaml");
  });

  test("community pairing instructions use a configured agent when available", () => {
    const text = buildPairingInstructions("custom-chat", "ABC123", {
      agentId: "agent-custom",
    });
    expect(text).toContain(
      "letta channels pair --channel custom-chat --code ABC123 --agent agent-custom",
    );
    expect(text).not.toContain("--agent <agent-id>");
    expect(text).not.toContain("Find the target agent with: letta agents list");
  });

  test("any non-first-party channel id triggers community copy", () => {
    const text = buildPairingInstructions("imessage", "QQQ");
    expect(text).toContain("Connect this chat to a Letta agent.");
    expect(text).toContain(
      "letta channels pair --channel imessage --code QQQ --agent <agent-id>",
    );
  });

  test("community unbound copy embeds the channel id and chat id in the CLI command", () => {
    const text = buildUnboundRouteInstructions("custom-signal", "+15551234567");
    expect(text).toContain("--channel custom-signal");
    expect(text).toContain("--chat-id +15551234567");
    expect(text).toContain("--agent <agent-id>");
  });

  test("community pairing copy points at a real subcommand", () => {
    // The actual handler in src/cli/subcommands/channels.ts is `letta channels
    // pair` (no `approve` subcommand). If someone introduces an `approve`
    // subcommand, this test should be updated together with the copy.
    const text = buildPairingInstructions("custom-chat", "X");
    expect(text).toMatch(/letta channels pair --channel custom-chat /);
    expect(text).not.toMatch(/letta channels pair approve/);
  });
});
