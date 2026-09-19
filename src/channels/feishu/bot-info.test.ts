import { describe, expect, test } from "bun:test";
import { parseFeishuBotInfo } from "@/channels/feishu/bot-info";

describe("parseFeishuBotInfo", () => {
  test("reads open_id and app_name from the official bot/v3/info body", () => {
    expect(
      parseFeishuBotInfo({
        code: 0,
        msg: "ok",
        bot: {
          activate_status: 2,
          app_name: "Letta",
          open_id: "ou_bot",
        },
      }),
    ).toEqual({ openId: "ou_bot", name: "Letta" });
  });

  test("reads a nested data.bot payload from the SDK wrapper", () => {
    expect(
      parseFeishuBotInfo({
        data: { bot: { open_id: "ou_nested", name: "Nested" } },
      }),
    ).toEqual({ openId: "ou_nested", name: "Nested" });
  });
});
