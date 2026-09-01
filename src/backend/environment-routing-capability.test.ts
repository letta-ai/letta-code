import { afterEach, describe, expect, test } from "bun:test";
import { isCloudServerUrl } from "@/backend/api/client";
import { APIBackend } from "@/backend/backend";

const originalBaseUrl = process.env.LETTA_BASE_URL;

afterEach(() => {
  if (originalBaseUrl === undefined) {
    delete process.env.LETTA_BASE_URL;
  } else {
    process.env.LETTA_BASE_URL = originalBaseUrl;
  }
});

describe("isCloudServerUrl", () => {
  test("true for the Letta Cloud API URL", () => {
    expect(isCloudServerUrl("https://api.letta.com")).toBe(true);
    expect(isCloudServerUrl("https://api.letta.com/")).toBe(true);
  });

  test("false for self-hosted and app-server URLs", () => {
    expect(isCloudServerUrl("http://localhost:8283")).toBe(false);
    expect(isCloudServerUrl("https://letta.internal.example.com")).toBe(false);
  });

  test("false for unparseable URLs", () => {
    expect(isCloudServerUrl("not a url")).toBe(false);
  });
});

describe("environmentRouting capability", () => {
  test("APIBackend reports environmentRouting for Cloud", () => {
    process.env.LETTA_BASE_URL = "https://api.letta.com";
    expect(new APIBackend().capabilities.environmentRouting).toBe(true);
  });

  test("APIBackend reports no environmentRouting for a self-hosted server", () => {
    process.env.LETTA_BASE_URL = "http://localhost:8283";
    expect(new APIBackend().capabilities.environmentRouting).toBe(false);
  });
});
