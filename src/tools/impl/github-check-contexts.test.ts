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
      workflowRun: {
        id: `run-${databaseId}`,
        createdAt: `2026-01-01T00:00:0${databaseId}Z`,
        workflow: { id: workflow },
      },
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

test.each(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"])(
  "normalizes snapshot checks and preserves unexplained aggregate %s",
  async (rollupState) => {
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
                state: rollupState,
                contexts: {
                  nodes: [
                    rollupState === "PENDING" || rollupState === "EXPECTED"
                      ? { ...check(1), status: "IN_PROGRESS", conclusion: "" }
                      : check(1, "FAILURE"),
                    check(2),
                  ],
                },
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
    expect(snapshot.checks[0]).toEqual(
      expect.objectContaining({ key: "check:2", phase: "success" }),
    );
    if (rollupState === "SUCCESS") expect(snapshot.checks).toHaveLength(1);
    else
      expect(snapshot.checks[1]).toEqual(
        expect.objectContaining({
          key: "check-rollup",
          phase:
            rollupState === "FAILURE" || rollupState === "ERROR"
              ? "failure"
              : "pending",
        }),
      );
    expect(snapshot.checkAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "attempt:1", phase: "failure" }),
      ]),
    );
    expect(hasGitHubPullRequestReadyConditions(snapshot)).toBe(
      rollupState === "SUCCESS",
    );
    expect(snapshot.readinessConfirmed).toBe(false);
  },
);

test.each(["FAILURE", "QUEUED"])(
  "preserves independent same-named jobs in one run with %s",
  (result) => {
    const failed = {
      ...check(1, result),
      status: result === "QUEUED" ? "QUEUED" : "COMPLETED",
    };
    const success = check(2);
    success.checkSuite.workflowRun.id = failed.checkSuite.workflowRun.id;
    success.checkSuite.workflowRun.createdAt =
      failed.checkSuite.workflowRun.createdAt;
    const laterRun = check(3);
    // Even a later run with one job cannot disambiguate the earlier matrix.
    expect(latestGitHubCheckContexts([success, laterRun, failed])).toEqual([
      success,
      laterRun,
      failed,
    ]);
  },
);

test("orders workflow runs by creation time, never database ID or response order", () => {
  const failed = check(2, "FAILURE");
  const success = check(1);
  success.checkSuite.workflowRun.createdAt = "2026-01-02T00:00:00Z";
  expect(latestGitHubCheckContexts([success, failed])).toEqual([success]);
  expect(latestGitHubCheckContexts([failed, success])).toEqual([success]);
  // A later-starting rerun of the older workflow does not change creation time.
  const rerun = { ...failed, startedAt: "2026-01-03T00:00:00Z" };
  expect(latestGitHubCheckContexts([rerun, success])).toEqual([success]);
});

test.each([null, "invalid", "2026-01-01T00:00:01Z"])(
  "preserves missing, invalid, or tied creation times: %s",
  (createdAt) => {
    const failed = check(1, "FAILURE");
    const success = {
      ...check(2),
      checkSuite: {
        ...check(2).checkSuite,
        workflowRun: { ...check(2).checkSuite.workflowRun, createdAt },
      },
    };
    expect(latestGitHubCheckContexts([failed, success])).toEqual([
      failed,
      success,
    ]);
  },
);

test("preserves a whole group when one workflow run lacks identity", () => {
  const failed = check(1, "FAILURE");
  const success = check(2);
  success.checkSuite.workflowRun.id = "";
  expect(latestGitHubCheckContexts([failed, success])).toEqual([
    failed,
    success,
  ]);
});
