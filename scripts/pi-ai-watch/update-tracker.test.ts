import { describe, expect, test } from "bun:test";
import { verifyUpgradePr } from "./update-tracker.ts";

const repo = "letta-ai/letta-code";
const url = `https://github.com/${repo}/pull/123`;
const analysis = { previous_version: "1.5.1", current_version: "1.5.2" };
const pull = {
  author: { login: "watcher-agent" },
  body: "Pi-ai-watch: 1.5.1...1.5.2",
  isDraft: false,
  state: "OPEN",
};

describe("pi-ai upgrade PR verification", () => {
  test("accepts a ready PR and fetches it from the expected repository", () => {
    const requests: Array<[string, string]> = [];
    verifyUpgradePr(url, repo, "watcher-agent", analysis, (number, name) => {
      requests.push([number, name]);
      return pull;
    });
    expect(requests).toEqual([["123", repo]]);
  });

  test("rejects a draft or closed PR", () => {
    expect(() =>
      verifyUpgradePr(url, repo, "watcher-agent", analysis, () => ({
        ...pull,
        isDraft: true,
      })),
    ).toThrow("must be ready for review");
    expect(() =>
      verifyUpgradePr(url, repo, "watcher-agent", analysis, () => ({
        ...pull,
        state: "CLOSED",
      })),
    ).toThrow("must be open");
  });

  test("rejects the wrong author or release marker", () => {
    expect(() =>
      verifyUpgradePr(url, repo, "watcher-agent", analysis, () => ({
        ...pull,
        author: { login: "someone-else" },
      })),
    ).toThrow("does not match");
    expect(() =>
      verifyUpgradePr(url, repo, "watcher-agent", analysis, () => ({
        ...pull,
        body: "Pi-ai-watch: 1.5.0...1.5.2",
      })),
    ).toThrow("missing marker");
  });

  test("rejects malformed and other-repository URLs before fetching", () => {
    let fetched = false;
    const getPull = () => {
      fetched = true;
      return pull;
    };
    expect(() =>
      verifyUpgradePr(`${url}/files`, repo, "watcher-agent", analysis, getPull),
    ).toThrow("Invalid GitHub pull request URL");
    expect(() =>
      verifyUpgradePr(
        "https://github.com/letta-ai/another-repo/pull/123",
        repo,
        "watcher-agent",
        analysis,
        getPull,
      ),
    ).toThrow(`must belong to ${repo}`);
    expect(fetched).toBe(false);
  });
});
