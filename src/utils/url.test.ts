import { describe, expect, test } from "bun:test";
import { isLoopbackHostname, isLoopbackUrl, parseUrl } from "@/utils/url";

describe("url utilities", () => {
  test("detects loopback hostnames", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("127.42.0.9")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("api.letta.com")).toBe(false);
  });

  test("parses URLs with optional http fallback", () => {
    expect(parseUrl("https://api.letta.com")?.hostname).toBe("api.letta.com");
    expect(parseUrl("localhost:8283")).toBeNull();
    expect(
      parseUrl("localhost:8283", { allowMissingProtocol: true })?.hostname,
    ).toBe("localhost");
  });

  test("detects loopback URLs", () => {
    expect(isLoopbackUrl("http://localhost:54321")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:54321")).toBe(true);
    expect(isLoopbackUrl("https://api.letta.com")).toBe(false);
    expect(isLoopbackUrl("localhost:54321")).toBe(false);
    expect(
      isLoopbackUrl("localhost:54321", { allowMissingProtocol: true }),
    ).toBe(true);
  });
});
