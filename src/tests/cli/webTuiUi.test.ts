import { describe, expect, test } from "bun:test";

describe("cli web-tui ui", () => {
  test("createWebTuiUi returns overrides when LETTA_CODE_WEB_UI_SOCKET is set", async () => {
    const prev = process.env.LETTA_CODE_WEB_UI_SOCKET;
    process.env.LETTA_CODE_WEB_UI_SOCKET = "/tmp/letta-web-tui-test.sock";

    const { createWebTuiUi } = await import("../../cli/web-tui/ui");
    const ui = createWebTuiUi();

    expect(ui.Input).toBeDefined();
    expect(ui.renderOverlay).toBeDefined();
    expect(ui.renderLiveItem).toBeDefined();

    if (prev === undefined) {
      delete process.env.LETTA_CODE_WEB_UI_SOCKET;
    } else {
      process.env.LETTA_CODE_WEB_UI_SOCKET = prev;
    }
  });
});
