import { describe, expect, test } from "bun:test";
import { diffGitHubPullRequestSnapshots } from "./github-pull-request-diff";
import {
  describeGitHubPullRequestSnapshot,
  fetchGitHubPullRequestSnapshot,
  type GitHubPullRequestSnapshot,
  isGitHubPullRequestReady,
  parseGitHubPullRequestUrl,
} from "./github-pull-request-watch";

const ref = {
  owner: "letta-ai",
  repo: "letta-code",
  number: 42,
  url: "https://github.com/letta-ai/letta-code/pull/42",
};

function snapshot(
  overrides: Partial<GitHubPullRequestSnapshot> = {},
): GitHubPullRequestSnapshot {
  return {
    ref,
    headSha: "a".repeat(40),
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    snapshotComplete: true,
    readinessConfirmed: true,
    checks: [],
    checkAttempts: [],
    comments: [],
    reviews: [],
    reviewThreads: [],
    ...overrides,
  };
}

describe("GitHub pull request URL parsing", () => {
  test("normalizes a full GitHub PR URL", () => {
    expect(
      parseGitHubPullRequestUrl(
        "https://github.com/letta-ai/letta-code/pull/42/",
      ),
    ).toEqual(ref);
  });

  test.each([
    "https://github.com/letta-ai/letta-code/issues/42",
    "http://github.com/letta-ai/letta-code/pull/42",
    "https://example.com/letta-ai/letta-code/pull/42",
    "https://user@example.com/letta-ai/letta-code/pull/42",
    "not-a-url",
  ])("rejects %s", (value) => {
    expect(() => parseGitHubPullRequestUrl(value)).toThrow("WatchPR url");
  });
});

describe("GitHub pull request snapshot fetch", () => {
  test("combines the current rollup with all check attempts", async () => {
    const calls: string[][] = [];
    const runGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      const endpoint = args.at(-1) ?? "";
      if (args.includes("graphql")) {
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                url: ref.url,
                state: "OPEN",
                isDraft: false,
                merged: false,
                headRefOid: "b".repeat(40),
                mergeable: "MERGEABLE",
                mergeStateStatus: "UNSTABLE",
                reviewDecision: "REVIEW_REQUIRED",
                comments: { nodes: [] },
                reviews: { nodes: [] },
                reviewThreads: { nodes: [] },
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          state: "FAILURE",
                          contexts: {
                            nodes: [
                              {
                                __typename: "CheckRun",
                                databaseId: 9,
                                name: "tests",
                                status: "IN_PROGRESS",
                                conclusion: null,
                                detailsUrl: "https://checks/current",
                              },
                            ],
                            pageInfo: { hasNextPage: false },
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        });
      }
      if (endpoint.includes("check-runs")) {
        return JSON.stringify([
          {
            check_runs: [
              {
                id: 7,
                name: "tests",
                status: "completed",
                conclusion: "failure",
                details_url: "https://checks/attempt-1",
                check_suite: { id: 10 },
                app: { slug: "github-actions" },
              },
              {
                id: 9,
                name: "tests",
                status: "in_progress",
                conclusion: null,
                details_url: "https://checks/current",
                check_suite: { id: 10 },
                app: { slug: "github-actions" },
              },
              {
                id: 30,
                name: "circle-tests",
                status: "completed",
                conclusion: "success",
                details_url: "https://checks/circle-current",
                check_suite: { id: 21 },
                app: { slug: "circleci" },
              },
            ],
          },
        ]);
      }
      if (endpoint.includes("statuses")) {
        return JSON.stringify([
          [
            {
              id: 15,
              context: "legacy-ci",
              state: "failure",
              target_url: "https://statuses/15",
            },
          ],
        ]);
      }
      return JSON.stringify([
        {
          check_suites: [
            {
              id: 10,
              status: "in_progress",
              conclusion: null,
              latest_check_runs_count: 2,
              app: { slug: "github-actions" },
            },
            {
              id: 11,
              status: "completed",
              conclusion: "startup_failure",
              latest_check_runs_count: 0,
              app: { name: "Buildkite" },
              url: "https://checks/suite",
            },
            {
              id: 20,
              status: "completed",
              conclusion: "failure",
              latest_check_runs_count: 0,
              app: { slug: "circleci", name: "CircleCI" },
              url: "https://checks/circle-old",
            },
            {
              id: 21,
              status: "completed",
              conclusion: "success",
              latest_check_runs_count: 1,
              app: { slug: "circleci", name: "CircleCI" },
              url: "https://checks/circle-current-suite",
            },
          ],
        },
      ]);
    };

    const result = await fetchGitHubPullRequestSnapshot(ref, {
      cwd: "/repo",
      deps: { runGh },
    });

    expect(calls).toHaveLength(4);
    expect(result.reviewDecision).toBe("REVIEW_REQUIRED");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "tests", phase: "pending" }),
        expect.objectContaining({
          name: "GitHub check rollup",
          phase: "failure",
        }),
      ]),
    );
    expect(result.checks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: "https://checks/circle-old" }),
      ]),
    );
    expect(result.checkAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "attempt:7", phase: "failure" }),
        expect.objectContaining({ key: "attempt:9", phase: "pending" }),
        expect.objectContaining({ key: "suite:11", phase: "failure" }),
        expect.objectContaining({
          key: "status-attempt:15",
          phase: "failure",
        }),
      ]),
    );
  });

  test("paginates PR comments and rejects partial GraphQL responses", async () => {
    let graphQlCalls = 0;
    const runGh = async (args: string[]): Promise<string> => {
      const endpoint = args.at(-1) ?? "";
      if (args.includes("graphql")) {
        graphQlCalls += 1;
        const secondPage = args.some((arg) => arg === "commentsAfter=cursor-1");
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                url: ref.url,
                state: "OPEN",
                headRefOid: "c".repeat(40),
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
                reviewDecision: "REVIEW_REQUIRED",
                comments: {
                  nodes: [
                    {
                      id: secondPage ? "comment-2" : "comment-1",
                      author: { login: "alice" },
                      body: secondPage ? "second" : "first",
                      url: secondPage
                        ? "https://comment/2"
                        : "https://comment/1",
                    },
                  ],
                  pageInfo: secondPage
                    ? { hasNextPage: false, endCursor: "cursor-2" }
                    : { hasNextPage: true, endCursor: "cursor-1" },
                },
                reviews: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                reviewThreads: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          state: "SUCCESS",
                          contexts: {
                            nodes: [
                              {
                                __typename: "CheckRun",
                                databaseId: secondPage ? 2 : 1,
                                name: secondPage
                                  ? "second-check"
                                  : "first-check",
                                status: "COMPLETED",
                                conclusion: "SUCCESS",
                              },
                            ],
                            pageInfo: secondPage
                              ? { hasNextPage: false, endCursor: "check-2" }
                              : { hasNextPage: true, endCursor: "check-1" },
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        });
      }
      if (endpoint.includes("check-runs")) {
        return JSON.stringify([{ check_runs: [] }]);
      }
      if (endpoint.includes("check-suites")) {
        return JSON.stringify([{ check_suites: [] }]);
      }
      return JSON.stringify([[]]);
    };

    const result = await fetchGitHubPullRequestSnapshot(ref, {
      cwd: "/repo",
      deps: { runGh },
    });
    expect(graphQlCalls).toBe(2);
    expect(result.comments.map((comment) => comment.id)).toEqual([
      "comment-1",
      "comment-2",
    ]);
    expect(result.checks.map((check) => check.name)).toEqual([
      "first-check",
      "second-check",
    ]);

    await expect(
      fetchGitHubPullRequestSnapshot(ref, {
        cwd: "/repo",
        deps: {
          runGh: async () =>
            JSON.stringify({
              data: {
                repository: {
                  pullRequest: { headRefOid: "d".repeat(40) },
                },
              },
              errors: [{ message: "reviewThreads unavailable" }],
            }),
        },
      }),
    ).rejects.toThrow("reviewThreads unavailable");
  });

  test("rejects a ready snapshot when PR metadata changes during the read", async () => {
    const runGh = async (args: string[]): Promise<string> => {
      const endpoint = args.at(-1) ?? "";
      if (args.includes("graphql")) {
        const isMetadataRead = !args.some((arg) =>
          arg.includes("comments(first: 100"),
        );
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                isDraft: false,
                merged: false,
                headRefOid: "e".repeat(40),
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
                reviewDecision: "APPROVED",
                comments: { nodes: [], pageInfo: { hasNextPage: false } },
                reviews: { nodes: [], pageInfo: { hasNextPage: false } },
                reviewThreads: {
                  nodes: isMetadataRead
                    ? [
                        {
                          id: "late-thread",
                          isResolved: false,
                          comments: { nodes: [] },
                        },
                      ]
                    : [],
                  totalCount: isMetadataRead ? 1 : 0,
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        });
      }
      if (endpoint.includes("check-runs")) {
        return JSON.stringify([{ check_runs: [] }]);
      }
      if (endpoint.includes("check-suites")) {
        return JSON.stringify([{ check_suites: [] }]);
      }
      return JSON.stringify([[]]);
    };

    await expect(
      fetchGitHubPullRequestSnapshot(ref, {
        cwd: "/repo",
        deps: { runGh },
      }),
    ).rejects.toThrow("state changed while WatchPR was reading it");
  });

  test("paginates comments inside a review thread", async () => {
    const comment = (id: string, body: string) => ({
      id,
      author: { login: "reviewer" },
      body,
      url: `https://comment/${id}`,
      updatedAt: "2026-01-01T00:00:00Z",
      path: "src/index.ts",
      line: 1,
      outdated: false,
    });
    const runGh = async (args: string[]): Promise<string> => {
      const endpoint = args.at(-1) ?? "";
      if (args.includes("graphql")) {
        if (args.includes("id=thread-1")) {
          return JSON.stringify({
            data: {
              node: {
                id: "thread-1",
                comments: {
                  nodes: [comment("old", "older")],
                  pageInfo: { hasPreviousPage: false, startCursor: "old" },
                },
              },
            },
          });
        }
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                headRefOid: "f".repeat(40),
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
                reviewDecision: "REVIEW_REQUIRED",
                comments: { nodes: [], pageInfo: { hasNextPage: false } },
                reviews: { nodes: [], pageInfo: { hasNextPage: false } },
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread-1",
                      isResolved: false,
                      comments: {
                        nodes: [comment("new", "newer")],
                        pageInfo: {
                          hasPreviousPage: true,
                          startCursor: "new",
                        },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        });
      }
      if (endpoint.includes("check-runs")) {
        return JSON.stringify([{ check_runs: [] }]);
      }
      if (endpoint.includes("check-suites")) {
        return JSON.stringify([{ check_suites: [] }]);
      }
      return JSON.stringify([[]]);
    };

    const result = await fetchGitHubPullRequestSnapshot(ref, {
      cwd: "/repo",
      deps: { runGh },
    });
    expect(result.reviewThreads[0]?.comments.map((item) => item.id)).toEqual([
      "old",
      "new",
    ]);
    expect(result.snapshotComplete).toBe(true);
  });
});

describe("GitHub pull request state diff", () => {
  test("the baseline surfaces failures, unresolved threads, and blockers", () => {
    const current = snapshot({
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      reviewDecision: "CHANGES_REQUESTED",
      checks: [
        {
          key: "check:tests",
          name: "tests",
          phase: "failure",
          result: "FAILURE",
        },
      ],
      reviewThreads: [
        {
          id: "thread-1",
          isResolved: false,
          comments: [
            {
              id: "inline-1",
              author: "reviewer",
              body: "Fix this",
              url: "https://review/1",
              updatedAt: "1",
              outdated: true,
            },
          ],
        },
      ],
    });

    const description = describeGitHubPullRequestSnapshot(current);
    expect(description).toContain("1 failing");
    expect(description).toContain("merge conflicts");
    expect(description).toContain("review decision CHANGES_REQUESTED");
    expect(description).toContain("Unresolved review thread (outdated)");
    expect(isGitHubPullRequestReady(current)).toBe(false);
  });

  test("reports failures immediately while other checks remain pending", () => {
    const previous = snapshot({
      mergeStateStatus: "BLOCKED",
      checks: [
        {
          key: "check:tests",
          name: "tests",
          phase: "pending",
          result: "IN_PROGRESS",
        },
        {
          key: "check:build",
          name: "build",
          phase: "pending",
          result: "QUEUED",
        },
      ],
    });
    const current = snapshot({
      mergeStateStatus: "UNSTABLE",
      checks: [
        {
          key: "check:tests",
          name: "tests",
          phase: "failure",
          result: "FAILURE",
          url: "https://checks/tests",
        },
        {
          key: "check:build",
          name: "build",
          phase: "pending",
          result: "IN_PROGRESS",
        },
      ],
    });

    const diff = diffGitHubPullRequestSnapshots(previous, current);
    expect(diff.events).toContain(
      "Check failed: tests (FAILURE). https://checks/tests",
    );
    expect(diff.events).toContain(
      "GitHub merge state changed from BLOCKED to UNSTABLE.",
    );
  });

  test("does not duplicate a URL-less current failure as an attempt", () => {
    const previous = snapshot({
      checks: [
        {
          key: "check:tests",
          name: "tests",
          phase: "pending",
          result: "IN_PROGRESS",
        },
      ],
    });
    const current = snapshot({
      checks: [
        {
          key: "check:tests",
          name: "tests",
          phase: "failure",
          result: "FAILURE",
        },
      ],
      checkAttempts: [
        {
          key: "attempt:2",
          name: "tests",
          phase: "failure",
          result: "FAILURE",
        },
      ],
    });

    const failures = diffGitHubPullRequestSnapshots(
      previous,
      current,
    ).events.filter(
      (event) => event.includes("tests") && event.includes("FAILURE"),
    );
    expect(failures).toHaveLength(1);
  });

  test("catches a failed attempt superseded by a successful rerun", () => {
    const currentCheck = {
      key: "check:tests:latest",
      name: "tests",
      phase: "success" as const,
      result: "SUCCESS",
      url: "https://checks/latest",
    };
    const previous = snapshot({ checks: [currentCheck] });
    const current = snapshot({
      checks: [currentCheck],
      checkAttempts: [
        {
          key: "attempt:7",
          name: "tests",
          phase: "failure",
          result: "FAILURE",
          url: "https://checks/failed",
        },
        {
          key: "attempt:8",
          name: "tests",
          phase: "success",
          result: "SUCCESS",
          url: "https://checks/latest",
        },
      ],
    });

    expect(diffGitHubPullRequestSnapshots(previous, current).events).toContain(
      "Check attempt failed before the next poll: tests (FAILURE). https://checks/failed",
    );
  });

  test("reports a rerun even while another check is already pending", () => {
    const previous = snapshot({
      checks: [
        {
          key: "check:tests",
          name: "tests",
          phase: "failure",
          result: "FAILURE",
        },
        {
          key: "check:build",
          name: "build",
          phase: "pending",
          result: "IN_PROGRESS",
        },
      ],
    });
    const current = snapshot({
      checks: [
        {
          key: "check:tests",
          name: "tests",
          phase: "pending",
          result: "QUEUED",
        },
        {
          key: "check:build",
          name: "build",
          phase: "pending",
          result: "IN_PROGRESS",
        },
      ],
    });

    expect(diffGitHubPullRequestSnapshots(previous, current).events).toContain(
      "Check rerun started: tests.",
    );
  });

  test("does not notify for checks that first appear as pending", () => {
    const previous = snapshot({
      checks: [],
      reviewDecision: "REVIEW_REQUIRED",
    });
    const current = snapshot({
      reviewDecision: "REVIEW_REQUIRED",
      checks: [
        {
          key: "check:tests",
          name: "tests",
          phase: "pending",
          result: "IN_PROGRESS",
        },
      ],
    });

    expect(diffGitHubPullRequestSnapshots(previous, current).events).toEqual(
      [],
    );
  });

  test("reports comments, reviews, inline findings, and reopened threads", () => {
    const oldThread = {
      id: "thread-1",
      isResolved: true,
      comments: [],
    };
    const current = snapshot({
      comments: [
        {
          id: "comment-1",
          author: "alice",
          body: "please fix the race",
          url: "https://comment/1",
          updatedAt: "1",
        },
      ],
      reviews: [
        {
          id: "review-1",
          author: "bob",
          body: "two findings",
          url: "https://review/1",
          updatedAt: "1",
          state: "CHANGES_REQUESTED",
        },
      ],
      reviewThreads: [
        {
          id: "thread-1",
          isResolved: false,
          comments: [
            {
              id: "inline-1",
              author: "bob",
              body: "this branch is stale",
              url: "https://inline/1",
              updatedAt: "1",
              path: "src/a.ts",
              line: 9,
              outdated: true,
            },
          ],
        },
      ],
    });
    const diff = diffGitHubPullRequestSnapshots(
      snapshot({ reviewThreads: [oldThread] }),
      current,
    );

    expect(diff.events.join("\n")).toContain("New PR comment from @alice");
    expect(diff.events.join("\n")).toContain(
      "New changes_requested review from @bob",
    );
    expect(diff.events).toContain("Review thread reopened: https://inline/1");
    expect(diff.events.join("\n")).toContain(
      "New inline review comment from @bob on src/a.ts:9 (outdated)",
    );
  });

  test("does not replace known mergeability with transient UNKNOWN", () => {
    const diff = diffGitHubPullRequestSnapshots(
      snapshot({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
      snapshot({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }),
    );
    expect(diff.events).toEqual([]);
  });

  test("fails readiness closed when a GitHub result page is truncated", () => {
    const current = snapshot({ snapshotComplete: false });
    expect(isGitHubPullRequestReady(current)).toBe(false);
    expect(describeGitHubPullRequestSnapshot(current)).toContain(
      "GitHub snapshot exceeded a 100-item page",
    );
  });

  test("does not call a clean PR ready while review is still required", () => {
    expect(
      isGitHubPullRequestReady(
        snapshot({ reviewDecision: "CHANGES_REQUESTED" }),
      ),
    ).toBe(false);
  });

  test("reports a new head and terminal merge", () => {
    const current = snapshot({
      headSha: "b".repeat(40),
      state: "MERGED",
      checkAttempts: [
        {
          key: "attempt:99",
          name: "tests",
          phase: "failure",
          result: "FAILURE",
          url: "https://checks/failed-on-new-head",
        },
      ],
    });
    const diff = diffGitHubPullRequestSnapshots(snapshot(), current);
    expect(diff.events[0]).toContain("PR head changed");
    expect(diff.events).toContain(
      "Check attempt failed on new head before the next poll: tests (FAILURE). https://checks/failed-on-new-head",
    );
    expect(diff.events).toContain(`PR merged at ${"b".repeat(12)}: ${ref.url}`);
    expect(diff.terminal).toBe(true);
  });
});
