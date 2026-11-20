import { describe, expect, test } from "bun:test";
import {
  formatSubagentError,
  isModelRefusalError,
  SUBAGENT_REFUSAL_NOTE,
} from "./subagent-refusal";

describe("isModelRefusalError", () => {
  test.each([
    "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.",
    "Listener turn stopped (anthropic_refusal)",
    "The model refused to complete this response",
    "The model refused to complete the request",
  ])("detects %p", (error) => {
    expect(isModelRefusalError(error)).toBe(true);
  });

  test.each([
    undefined,
    "",
    "Connection refused",
    "ECONNREFUSED 127.0.0.1:8283",
    "Subagent process exited with code 1 before returning a result.",
    "Refusing to switch into /tmp/wt to avoid two agents editing it concurrently.",
  ])("ignores %p", (error) => {
    expect(isModelRefusalError(error)).toBe(false);
  });
});

describe("formatSubagentError", () => {
  test("appends the refusal note after the original error", () => {
    const error =
      "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.";
    expect(formatSubagentError(error)).toBe(
      `Error: ${error}\n\n${SUBAGENT_REFUSAL_NOTE}`,
    );
  });

  test("leaves other failures unchanged", () => {
    expect(formatSubagentError("Connection refused")).toBe(
      "Error: Connection refused",
    );
  });
});
