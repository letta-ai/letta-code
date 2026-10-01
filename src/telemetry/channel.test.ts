import { afterEach, describe, expect, test } from "bun:test";
import { extractInputChannel, messageChannelTelemetry } from "./channel";
import { type TelemetryEvent, telemetry } from "./index";

const state = telemetry as unknown as {
  events: TelemetryEvent[];
  messageCount: number;
};
const originalEvents = state.events;
const originalMessageCount = state.messageCount;
const originalSetting = process.env.LETTA_CODE_TELEM;
afterEach(() => {
  state.events = originalEvents;
  state.messageCount = originalMessageCount;
  if (originalSetting === undefined) delete process.env.LETTA_CODE_TELEM;
  else process.env.LETTA_CODE_TELEM = originalSetting;
});

const notification = (channel: string) =>
  `<channel-notification source="${channel}" sender_name="Private Name">\nprivate message\n</channel-notification>`;

describe("channel telemetry", () => {
  test("recognizes incoming channel labels without copying content", () => {
    for (const channel of ["slack", "microsoftTeams", "telegram"]) {
      expect(extractInputChannel(notification(channel))).toBe(channel);
    }
    expect(
      extractInputChannel(
        `<system-reminder>context</system-reminder>\n${notification("slack")}`,
      ),
    ).toBe("slack");
    expect(extractInputChannel(notification("private-custom-id"))).toBe(
      "other",
    );
    expect(extractInputChannel("normal user input")).toBeUndefined();
    expect(
      extractInputChannel(`Example: \`${notification("slack")}\``),
    ).toBeUndefined();
    expect(
      extractInputChannel(`\`\`\`xml\n${notification("slack")}\n\`\`\``),
    ).toBeUndefined();
  });

  test("does not multiply user input events for batched messages", () => {
    expect(
      extractInputChannel(`${notification("slack")}\n${notification("slack")}`),
    ).toBe("slack");
    expect(
      extractInputChannel(
        `${notification("slack")}\n${notification("telegram")}`,
      ),
    ).toBe("mixed");
    state.events = [];
    process.env.LETTA_CODE_TELEM = "1";
    telemetry.trackUserInput(
      `${notification("slack")}\n${notification("slack")}`,
      "user",
      "model-1",
    );
    expect(state.events).toHaveLength(1);
    expect(state.events[0]?.data.channel).toBe("slack");
    expect(JSON.stringify(state.events)).not.toContain("private message");
    expect(JSON.stringify(state.events)).not.toContain("Private Name");
    telemetry.trackUserInput("ordinary input", "user", "model-1");
    expect(state.events[1]?.data.channel).toBeUndefined();
  });

  test("only retains channel and action from outgoing arguments", () => {
    expect(
      messageChannelTelemetry({
        channel: "slack",
        action: "send",
        message: "secret",
        chat_id: "private-id",
      }),
    ).toEqual({ channel: "slack", channel_action: "send" });
    expect(
      messageChannelTelemetry({ channel: "microsoftTeams", action: "react" }),
    ).toEqual({
      channel: "microsoftTeams",
      channel_action: "react",
    });
    expect(
      messageChannelTelemetry({
        channel: "private-name",
        action: "private-action",
      }),
    ).toEqual({
      channel: "other",
      channel_action: "other",
    });
    expect(messageChannelTelemetry({})).toEqual({
      channel: undefined,
      channel_action: undefined,
    });
  });
});
