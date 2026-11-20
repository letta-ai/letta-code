import { describe, expect, test } from "bun:test";
import { monitorPullRequestHint } from "./monitor-pr-hint";

const URL = "https://github.com/octo-org/octo-repo/pull/42";

describe("monitorPullRequestHint", () => {
  test("points gh pr view loops with --repo at WatchPR on the PR URL", () => {
    const hint = monitorPullRequestHint(
      `p=""; while true; do s=$(gh pr view 42 -R octo-org/octo-repo --json state,reviewDecision -q '.state'); [ "$s" != "$p" ] && echo "$s"; p="$s"; sleep 120; done`,
    );
    expect(hint).toContain("This command polls a GitHub pull request.");
    expect(hint).toContain(`call WatchPR on ${URL} instead.`);
  });

  test("reads --repo= and a repo flag placed before the subcommand args", () => {
    expect(
      monitorPullRequestHint("gh pr checks 42 --repo=octo-org/octo-repo"),
    ).toContain(URL);
    expect(
      monitorPullRequestHint(
        "gh -R octo-org/octo-repo pr view 42 --json state",
      ),
    ).toContain(URL);
    expect(
      monitorPullRequestHint("gh pr view --repo octo-org/octo-repo 42"),
    ).toContain(URL);
  });

  test("uses a PR URL argument directly", () => {
    expect(monitorPullRequestHint(`gh pr view ${URL} --json state`)).toContain(
      `WatchPR on ${URL}`,
    );
  });

  test("matches gh api pulls endpoints", () => {
    expect(
      monitorPullRequestHint(
        "gh api repos/octo-org/octo-repo/pulls/42 --jq .mergeable_state",
      ),
    ).toContain(URL);
    expect(
      monitorPullRequestHint(
        "gh api -H 'Accept: application/vnd.github+json' repos/octo-org/octo-repo/pulls/42/reviews",
      ),
    ).toContain(URL);
  });

  test("falls back to a generic target when the repo is unknown", () => {
    expect(monitorPullRequestHint("gh pr view 42 --json state")).toContain(
      "call WatchPR on that pull request instead.",
    );
    expect(monitorPullRequestHint("gh pr status")).toContain(
      "that pull request",
    );
  });

  test("ignores commands that do not poll a pull request", () => {
    for (const command of [
      `seen=""; while true; do gh run list -R octo-org/octo-repo --event workflow_dispatch --limit 12 --json databaseId,status; sleep 60; done`,
      "gh run watch 123 -R octo-org/octo-repo",
      "gh pr list -R octo-org/octo-repo",
      "gh pr create --draft",
      "gh api repos/octo-org/octo-repo/actions/runs",
      "tail -f build.log",
      "",
    ]) {
      expect(monitorPullRequestHint(command)).toBeUndefined();
    }
  });
});
