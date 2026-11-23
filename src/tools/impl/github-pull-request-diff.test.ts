import { expect, test } from "bun:test";
import { diffGitHubPullRequestSnapshots } from "./github-pull-request-diff";
import type { GitHubPullRequestSnapshot } from "./github-pull-request-types";

const baseline: GitHubPullRequestSnapshot = {
  ref: {
    owner: "owner",
    repo: "repo",
    number: 1,
    url: "https://github.com/owner/repo/pull/1",
  },
  headSha: "abc",
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "NONE",
  readinessConfirmed: false,
  checks: [{ key: "ci", name: "CI", phase: "pending", result: "PENDING" }],
  checkAttempts: [],
  comments: [],
  reviews: [],
  reviewThreads: [],
};

test("narrow merge/close/conflict notifications ignore unrelated events without hiding terminal state", () => {
  const current = {
    ...baseline,
    mergeable: "CONFLICTING",
    comments: [
      {
        id: "c",
        author: "alice",
        body: "hello",
        url: "https://github.com/comment",
        updatedAt: "1",
      },
    ],
  };
  expect(
    diffGitHubPullRequestSnapshots(baseline, current, [
      "merged",
      "closed",
      "conflict",
    ]).events,
  ).toHaveLength(1);
  expect(
    diffGitHubPullRequestSnapshots(baseline, current).events.length,
  ).toBeGreaterThan(1);
  const merged = diffGitHubPullRequestSnapshots(
    current,
    { ...current, state: "MERGED" },
    ["comment"],
  );
  expect(merged.terminal).toBe(true);
  expect(merged.events).toHaveLength(0);
});

test("checks_done emits once on completion with failures even if mergeability is blocked", () => {
  const completed: GitHubPullRequestSnapshot = {
    ...baseline,
    mergeable: "CONFLICTING",
    checks: [{ key: "ci", name: "CI", phase: "failure", result: "FAILURE" }],
  };
  const diff = diffGitHubPullRequestSnapshots(baseline, completed, [
    "checks_done",
  ]);
  expect(diff.events).toHaveLength(1);
  expect(diff.events[0]).toContain("1 failing, 0 pending");
  expect(diff.terminal).toBe(false);
  expect(
    diffGitHubPullRequestSnapshots(completed, completed, ["checks_done"])
      .events,
  ).toHaveLength(0);
});
