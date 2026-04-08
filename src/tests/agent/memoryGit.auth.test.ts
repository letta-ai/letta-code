import { describe, expect, test } from "bun:test";

import {
  formatGitCredentialHelperPath,
  getGitRemoteUrl,
  isMemfsRemoteUrlForAgent,
  normalizeCredentialBaseUrl,
} from "../../agent/memoryGit";

describe("normalizeCredentialBaseUrl", () => {
  test("normalizes Letta Cloud URL to origin", () => {
    expect(normalizeCredentialBaseUrl("https://api.letta.com")).toBe(
      "https://api.letta.com",
    );
  });

  describe("getGitRemoteUrl", () => {
    test("builds remote URL from provided base URL", () => {
      expect(getGitRemoteUrl("agent-123", "http://localhost:51338/")).toBe(
        "http://localhost:51338/v1/git/agent-123/state.git",
      );
    });
  });

  describe("isMemfsRemoteUrlForAgent", () => {
    test("returns true for this agent's memfs HTTP URL", () => {
      expect(
        isMemfsRemoteUrlForAgent(
          "http://localhost:51338/v1/git/agent-123/state.git/",
          "agent-123",
        ),
      ).toBe(true);
    });

    test("returns false for different agent ID", () => {
      expect(
        isMemfsRemoteUrlForAgent(
          "http://localhost:51338/v1/git/agent-999/state.git",
          "agent-123",
        ),
      ).toBe(false);
    });

    test("returns false for non-memfs remotes", () => {
      expect(isMemfsRemoteUrlForAgent("/tmp/remote.git", "agent-123")).toBe(
        false,
      );
    });
  });

  test("strips trailing slashes", () => {
    expect(normalizeCredentialBaseUrl("https://api.letta.com///")).toBe(
      "https://api.letta.com",
    );
  });

  test("drops path/query/fragment and keeps origin", () => {
    expect(
      normalizeCredentialBaseUrl(
        "https://api.letta.com/custom/path?foo=bar#fragment",
      ),
    ).toBe("https://api.letta.com");
  });

  test("preserves explicit port", () => {
    expect(normalizeCredentialBaseUrl("http://localhost:8283/v1/")).toBe(
      "http://localhost:8283",
    );
  });

  test("falls back to trimmed value when URL parsing fails", () => {
    expect(normalizeCredentialBaseUrl("not-a-valid-url///")).toBe(
      "not-a-valid-url",
    );
  });
});

describe("formatGitCredentialHelperPath", () => {
  test("normalizes slashes and escapes whitespace for helper command parsing", () => {
    expect(
      formatGitCredentialHelperPath(
        String.raw`C:\Users\Jane Doe\.letta\agents\agent-1\memory\.git\letta-credential-helper.cmd`,
      ),
    ).toBe(
      "C:/Users/Jane\\ Doe/.letta/agents/agent-1/memory/.git/letta-credential-helper.cmd",
    );
  });
});
