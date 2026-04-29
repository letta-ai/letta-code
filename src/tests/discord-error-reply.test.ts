import { describe, expect, test } from "bun:test";

import {
  extractErrorDetail,
  formatDiscordDeliveryError,
} from "../channels/discord/errorReply";

describe("extractErrorDetail", () => {
  test("prefers nested Letta SDK error.error.detail", () => {
    const err = {
      status: 404,
      message: "404 Not Found",
      error: {
        error: { detail: "Agent with ID agent-nested not found" },
      },
    };
    expect(extractErrorDetail(err)).toBe(
      "Agent with ID agent-nested not found",
    );
  });

  test("prefers Letta SDK error.detail", () => {
    const err = {
      status: 404,
      message: "404 Not Found",
      error: { detail: "Agent with ID agent-abc not found" },
    };
    expect(extractErrorDetail(err)).toBe("Agent with ID agent-abc not found");
  });

  test("falls back to error.message", () => {
    expect(extractErrorDetail(new Error("boom"))).toBe("boom");
  });

  test("falls back to String(error) for non-Error values", () => {
    expect(extractErrorDetail("plain string")).toBe("plain string");
  });

  test("trims whitespace from detail and message", () => {
    const err = { error: { detail: "  spaced  " } };
    expect(extractErrorDetail(err)).toBe("spaced");
  });

  test("falls back to direct error.message when detail is missing", () => {
    const err = { error: { message: "operator-visible message" } };
    expect(extractErrorDetail(err)).toBe("operator-visible message");
  });
});

describe("formatDiscordDeliveryError", () => {
  test("special-cases nested 404 agent-not-found", () => {
    const err = {
      status: 404,
      error: {
        error: { detail: "Agent with ID agent-nested not found" },
      },
    };
    const msg = formatDiscordDeliveryError(err);
    expect(msg).toContain("agent I'm bound to");
    expect(msg).toContain("letta channels bind --channel discord");
  });

  test("special-cases 404 agent-not-found", () => {
    const err = {
      status: 404,
      error: { detail: "Agent with ID agent-33b3 not found" },
    };
    const msg = formatDiscordDeliveryError(err);
    expect(msg).toContain("agent I'm bound to");
    expect(msg).toContain("letta channels bind --channel discord");
  });

  test("does not match generic 404s as agent-not-found", () => {
    const err = { status: 404, error: { detail: "Resource missing" } };
    const msg = formatDiscordDeliveryError(err);
    expect(msg).not.toContain("rebind");
    expect(msg).toContain("Resource missing");
  });

  test("special-cases 401", () => {
    const err = { status: 401, message: "Unauthorized" };
    const msg = formatDiscordDeliveryError(err);
    expect(msg).toContain("API credentials were rejected");
  });

  test("special-cases 403", () => {
    const err = { status: 403, message: "Forbidden" };
    const msg = formatDiscordDeliveryError(err);
    expect(msg).toContain("API credentials were rejected");
  });

  test("falls back to generic message for unknown errors", () => {
    const err = new Error("something exploded");
    const msg = formatDiscordDeliveryError(err);
    expect(msg).toContain("something went wrong");
    expect(msg).toContain("`something exploded`");
  });

  test("truncates very long detail strings", () => {
    const detail = "x".repeat(500);
    const msg = formatDiscordDeliveryError(new Error(detail));
    expect(msg.length).toBeLessThan(detail.length + 80);
    expect(msg).toContain("…");
  });
});
