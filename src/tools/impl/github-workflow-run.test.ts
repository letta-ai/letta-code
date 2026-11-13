import { expect, test } from "bun:test";
import {
  createGitHubWorkflowRunFetcher,
  parseGitHubWorkflowRunUrl,
  workflowRunSnapshot,
} from "./github-workflow-run";

test("run URL parsing normalizes IDs and rejects non-run or untrusted URLs", () => {
  expect(
    parseGitHubWorkflowRunUrl(
      "https://github.com/owner/repo/actions/runs/42/?x=1",
    ),
  ).toEqual({
    owner: "owner",
    repo: "repo",
    number: 42,
    url: "https://github.com/owner/repo/actions/runs/42",
  });
  for (const value of [
    "https://example.com/owner/repo/actions/runs/42",
    "https://user@github.com/owner/repo/actions/runs/42",
    "https://github.com/owner/repo/pull/42",
    "https://github.com/owner/repo/actions/runs/0",
  ])
    expect(() => parseGitHubWorkflowRunUrl(value)).toThrow();
});

test("old-server fallback stays local to one watch and preserves failed steps and completion", async () => {
  const ref = parseGitHubWorkflowRunUrl(
    "https://github.com/owner/repo/actions/runs/42",
  );
  let requests = 0;
  let reads = 0;
  const fetch = createGitHubWorkflowRunFetcher({
    isCloud: () => true,
    request: async () => {
      requests++;
      return undefined;
    },
    runGh: async (args) => {
      expect(args).toEqual([
        "run",
        "view",
        "42",
        "-R",
        "owner/repo",
        "--json",
        "status,conclusion,headSha,jobs",
      ]);
      return JSON.stringify({
        headSha: "abc",
        status: ++reads === 1 ? "in_progress" : "completed",
        conclusion: reads === 1 ? null : "failure",
        jobs: [
          {
            name: "build",
            conclusion: "failure",
            steps: [{ name: "compile", conclusion: "failure" }],
          },
        ],
      });
    },
  });
  expect((await fetch(ref, { cwd: "/tmp" })).state).toBe("OPEN");
  const completed = await fetch(ref, { cwd: "/tmp" });
  expect(completed.state).toBe("CLOSED");
  expect(completed.workflowRun?.jobs[0]?.steps?.[0]?.name).toBe("compile");
  expect(requests).toBe(1);
  expect(
    workflowRunSnapshot(ref, {
      headSha: "abc",
      status: "waiting",
      conclusion: null,
      jobs: [],
    }).state,
  ).toBe("OPEN");
});

test("an initial Cloud cooldown falls back once without advancing later stale snapshots", async () => {
  const ref = parseGitHubWorkflowRunUrl(
    "https://github.com/owner/repo/actions/runs/42",
  );
  let localReads = 0;
  const fetch = createGitHubWorkflowRunFetcher({
    isCloud: () => true,
    request: async () => ({ snapshot: null, inaccessible: false, stale: true }),
    runGh: async () => {
      localReads++;
      return JSON.stringify({
        headSha: "abc",
        status: "in_progress",
        conclusion: null,
        jobs: [],
      });
    },
  });
  expect((await fetch(ref, { cwd: "/tmp" })).state).toBe("OPEN");
  await expect(fetch(ref, { cwd: "/tmp" })).rejects.toThrow("cooling down");
  expect(localReads).toBe(1);
});
