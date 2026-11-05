import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { OAUTH_CONFIG, resolveAuthBaseUrl } from "@/auth/oauth";

describe("resolveAuthBaseUrl", () => {
  let originalOverride: string | undefined;

  beforeEach(() => {
    originalOverride = process.env.LETTA_AUTH_BASE_URL;
  });

  afterEach(() => {
    if (originalOverride === undefined) {
      delete process.env.LETTA_AUTH_BASE_URL;
    } else {
      process.env.LETTA_AUTH_BASE_URL = originalOverride;
    }
  });

  test("defaults to app.letta.com when LETTA_AUTH_BASE_URL is unset", () => {
    delete process.env.LETTA_AUTH_BASE_URL;
    expect(resolveAuthBaseUrl()).toBe("https://app.letta.com");
  });

  test("defaults to app.letta.com for blank overrides", () => {
    process.env.LETTA_AUTH_BASE_URL = "   ";
    expect(resolveAuthBaseUrl()).toBe("https://app.letta.com");
  });

  test("honors an https override and normalizes to the origin", () => {
    process.env.LETTA_AUTH_BASE_URL = "https://app.hiredream.com/some/path?q=1";
    expect(resolveAuthBaseUrl()).toBe("https://app.hiredream.com");
    expect(OAUTH_CONFIG.authBaseUrl).toBe("https://app.hiredream.com");
  });

  test("allows http for localhost development", () => {
    process.env.LETTA_AUTH_BASE_URL = "http://localhost:3000";
    expect(resolveAuthBaseUrl()).toBe("http://localhost:3000");
  });

  test("falls back to the default for non-localhost http", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.LETTA_AUTH_BASE_URL = "http://app.hiredream.com";
      expect(resolveAuthBaseUrl()).toBe("https://app.letta.com");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("falls back to the default for invalid URLs", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.LETTA_AUTH_BASE_URL = "not-a-url";
      expect(resolveAuthBaseUrl()).toBe("https://app.letta.com");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
