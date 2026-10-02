import { describe, expect, test } from "bun:test";
import { buildDesktopViewerUrl } from "@/cli/helpers/app-urls";

describe("buildDesktopViewerUrl", () => {
  test("opens the chat desktop viewer on the relay path, not the relay host", () => {
    const url = buildDesktopViewerUrl(
      "https://api.letta.com/v1/sandboxes/sb-1/desktop-session/ws?token=t0k",
      "2026-09-28T23:00:00.000Z",
    );
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://chat.letta.com/desktop",
    );
    const hash = new URLSearchParams(parsed.hash.slice(1));
    expect(hash.get("path")).toBe(
      "/v1/sandboxes/sb-1/desktop-session/ws?token=t0k",
    );
    expect(hash.get("expiresAt")).toBe("2026-09-28T23:00:00.000Z");
    expect(url).not.toContain("api.letta.com");
  });
});
