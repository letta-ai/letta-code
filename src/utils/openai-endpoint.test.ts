import { describe, expect, test } from "bun:test";
import {
  isOfficialOpenAIEndpoint,
  isOpenAICompatibleProxyEndpoint,
} from "./openai-endpoint";

describe("OpenAI endpoint classification", () => {
  test("recognizes the official OpenAI API regardless of path formatting", () => {
    expect(isOfficialOpenAIEndpoint("https://api.openai.com/v1")).toBe(true);
    expect(isOfficialOpenAIEndpoint("https://API.OPENAI.COM/v1/")).toBe(true);
    expect(isOfficialOpenAIEndpoint("https://api.openai.com./v1")).toBe(true);
    expect(isOpenAICompatibleProxyEndpoint("https://api.openai.com/v1")).toBe(
      false,
    );
  });

  test("classifies valid non-OpenAI hosts as compatible proxies", () => {
    expect(
      isOpenAICompatibleProxyEndpoint("https://proxy.example.com/openai/v1"),
    ).toBe(true);
    expect(
      isOfficialOpenAIEndpoint("https://api.openai.com.example.com/v1"),
    ).toBe(false);
  });

  test("does not infer proxy status without a valid endpoint", () => {
    expect(isOpenAICompatibleProxyEndpoint(undefined)).toBe(false);
    expect(isOpenAICompatibleProxyEndpoint("not a url")).toBe(false);
  });
});
