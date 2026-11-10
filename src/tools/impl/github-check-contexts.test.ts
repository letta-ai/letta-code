import { expect, test } from "bun:test";
import { latestGitHubCheckContexts } from "./github-check-contexts";
import { hasGitHubPullRequestReadyConditions } from "./github-pull-request-state";
import { fetchGitHubPullRequestSnapshot } from "./github-pull-request-watch";

function check(
  databaseId: number,
  conclusion = "SUCCESS",
  workflow = "workflow-a",
  app = "app-a",
  isRequired = false,
) {
  return {
    __typename: "CheckRun",
    databaseId,
    name: "tests",
    status: "COMPLETED",
    conclusion,
    isRequired,
    checkSuite: {
      app: { id: app },
      workflowRun: { workflow: { id: workflow } },
    },
  };
}

test("selects the newest attempt independent of result and response ordering", () => {
  const failed = check(1, "FAILURE");
  const success = check(2);
  expect(latestGitHubCheckContexts([success, failed])).toEqual([success]);
  const newerFailure = check(3, "FAILURE");
  expect(latestGitHubCheckContexts([failed, newerFailure, success])).toEqual([
    newerFailure,
  ]);
  const pending = { ...check(4), status: "QUEUED", conclusion: "" };
  expect(latestGitHubCheckContexts([pending, newerFailure])).toEqual([pending]);
});

test("preserves checks from other workflows, apps, and required-check identities", () => {
  const contexts = [
    check(1, "FAILURE"),
    check(2, "SUCCESS", "workflow-b"),
    check(3, "SUCCESS", "workflow-a", "app-b"),
    check(4, "SUCCESS", "workflow-a", "app-a", true),
  ];
  expect(latestGitHubCheckContexts(contexts)).toEqual(contexts);
});

test("keeps ambiguous checks and status contexts", () => {
  const contexts = [
    { ...check(1, "FAILURE"), checkSuite: null },
    { ...check(2), checkSuite: null },
    { __typename: "StatusContext", name: "tests", databaseId: 3 },
    { ...check(4), isRequired: null },
  ];
  expect(latestGitHubCheckContexts(contexts)).toEqual(contexts);
});

test("normalizes snapshot checks without resurrecting the stale rollup failure or dropping attempt history", async () => {
  const ref = {
    owner: "example",
    repo: "repo",
    number: 1,
    url: "https://github.com/example/repo/pull/1",
  };
  const pullRequest = {
    state: "OPEN",
    headRefOid: "a".repeat(40),
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: "FAILURE",
              contexts: { nodes: [check(1, "FAILURE"), check(2)] },
            },
          },
        },
      ],
    },
  };
  const snapshot = await fetchGitHubPullRequestSnapshot(ref, {
    cwd: "/tmp",
    deps: {
      runGh: async (args) => {
        if (args.includes("graphql"))
          return JSON.stringify({ data: { repository: { pullRequest } } });
        const endpoint = args.at(-1) ?? "";
        if (endpoint.includes("check-runs"))
          return JSON.stringify([
            {
              check_runs: [
                {
                  id: 1,
                  name: "tests",
                  status: "completed",
                  conclusion: "failure",
                },
                {
                  id: 2,
                  name: "tests",
                  status: "completed",
                  conclusion: "success",
                },
              ],
            },
          ]);
        if (endpoint.includes("check-suites"))
          return JSON.stringify([{ check_suites: [] }]);
        return "[[]]";
      },
    },
  });
  expect(snapshot.checks).toEqual([
    expect.objectContaining({ key: "check:2", phase: "success" }),
  ]);
  expect(snapshot.checkAttempts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: "attempt:1", phase: "failure" }),
    ]),
  );
  expect(hasGitHubPullRequestReadyConditions(snapshot)).toBe(true);
  expect(snapshot.readinessConfirmed).toBe(false);
});
