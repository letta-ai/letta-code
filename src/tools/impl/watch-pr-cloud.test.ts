import { describe, expect, spyOn, test } from "bun:test";
import { ApiRequestError } from "@/backend/api/request";
import { experimentManager } from "@/experiments/manager";
import type { CloudPullRequestSnapshot } from "./github-pull-request-cloud";
import { toClientSnapshot } from "./github-pull-request-cloud";
import { describeGitHubPullRequestSnapshot } from "./github-pull-request-state";
import { startCloudPullRequestWatch } from "./watch-pr-cloud";

const args = {
  url: "https://github.com/example/repo/pull/1",
  toolCallId: "watch-call-1",
  notify_on: ["state" as const],
  parentScope: { agentId: "agent-1", conversationId: "conv-1" },
};
const initial: CloudPullRequestSnapshot = {
  ref: { owner: "example", repo: "repo", number: 1, url: args.url },
  head_sha: "initial-head",
  state: "OPEN",
  is_draft: false,
  merged: false,
  merged_by: null,
  mergeable: "CONFLICTING",
  merge_state_status: "DIRTY",
  review_decision: "CHANGES_REQUESTED",
  readiness_confirmed: false,
  checks: [{ key: "ci", name: "CI", phase: "failure", result: "FAILURE" }],
  check_attempts: [],
  comments: [],
  reviews: [],
  review_threads: [
    {
      id: "thread-1",
      is_resolved: false,
      comments: [
        {
          id: "comment-1",
          author: "reviewer",
          body: "Please fix",
          url: "https://github.com/example/repo/pull/1#discussion-1",
          updated_at: "2026-11-17T00:00:00Z",
          outdated: false,
        },
      ],
    },
  ],
};
describe("cloud WatchPR registration", () => {
  test("leaves local resume IDs on the local path when cloud watches are enabled", async () => {
    let requests = 0;
    for (const url of [undefined, args.url]) {
      const result = await startCloudPullRequestWatch(
        { resume: "monitor_local", parentScope: args.parentScope, url },
        {
          enabled: () => true,
          request: async () => {
            requests++;
            throw new Error("Local resume must not make a cloud request");
          },
        },
      );
      expect(result).toBeUndefined();
    }
    expect(requests).toBe(0);
  });
  test("uses the registered experiment instead of bypassing it with the env flag", async () => {
    const originalFlag = process.env.LETTA_CLOUD_WATCH_PR;
    process.env.LETTA_CLOUD_WATCH_PR = "1";
    expect(experimentManager.getSnapshot("cloud_watch_pr")).toMatchObject({
      id: "cloud_watch_pr",
      envVar: "LETTA_CLOUD_WATCH_PR",
      enabled: true,
      source: "env",
    });
    const enabled = spyOn(experimentManager, "isEnabled").mockReturnValue(
      false,
    );
    try {
      expect(await startCloudPullRequestWatch(args)).toBeUndefined();
      expect(enabled).toHaveBeenCalledWith("cloud_watch_pr");
    } finally {
      enabled.mockRestore();
      if (originalFlag === undefined) delete process.env.LETTA_CLOUD_WATCH_PR;
      else process.env.LETTA_CLOUD_WATCH_PR = originalFlag;
    }
  });
  test("accepts a pending baseline while registration is backing off", async () => {
    const result = await startCloudPullRequestWatch(args, {
      enabled: () => true,
      request: async () => ({ id: "cmon-1" }) as never,
    });
    expect(result?.taskId).toBe("cmon-1");
    expect(result?.headSha).toBe("");
    expect(result?.content[0]?.text).toContain("pending");
  });
  test("registers with filters and falls back only when the repository is inaccessible", async () => {
    const calls: unknown[] = [];
    const result = await startCloudPullRequestWatch(args, {
      enabled: () => true,
      request: async (...call: unknown[]) => {
        calls.push(call);
        return { id: "cmon-1", initial_snapshot: initial } as never;
      },
    });
    expect(result?.content[0]?.text).toContain("cloud watch");
    expect(result?.content[0]?.text).toContain("sandbox can sleep");
    expect(result?.taskId).toBe("cmon-1");
    expect(result?.headSha).toBe(initial.head_sha);
    const summary = describeGitHubPullRequestSnapshot(
      toClientSnapshot(initial.ref, initial),
    );
    expect(result?.content[0]?.text).toContain(`Current state:\n${summary}`);
    expect(result?.content[0]?.text).toContain("Failing checks: CI.");
    expect(result?.content[0]?.text).toContain(
      "Unresolved review thread: https://github.com/example/repo/pull/1#discussion-1",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject([
      "POST",
      "/v1/conversations/conv-1/cloud-monitors",
      {
        tool_call_id: "watch-call-1",
        source: {
          type: "github_pull_request",
          owner: "example",
          repo: "repo",
          number: 1,
          notify_on: ["state"],
        },
      },
      undefined,
    ]);
    expect(
      await startCloudPullRequestWatch(args, { enabled: () => false }),
    ).toBeUndefined();
    expect(
      await startCloudPullRequestWatch(args, {
        enabled: () => true,
        request: async () => {
          throw new ApiRequestError(
            "inaccessible",
            400,
            JSON.stringify({ errorCode: "REPOSITORY_INACCESSIBLE" }),
          );
        },
      }),
    ).toBeUndefined();
    const resumed = await startCloudPullRequestWatch(
      { ...args, resume: "cmon-1" },
      {
        enabled: () => false,
        request: async (...call: unknown[]) => {
          expect(call[0]).toBe("GET");
          expect(call[1]).toBe(
            "/v1/conversations/conv-1/cloud-monitors/cmon-1",
          );
          return {
            id: "cmon-1",
            status: "running",
            source: {
              type: "github_pull_request",
              owner: "example",
              repo: "repo",
              number: 1,
            },
          } as never;
        },
      },
    );
    expect(resumed?.taskId).toBe("cmon-1");
    expect(resumed?.content[0]?.text).toBe(
      "WatchPR cmon-1 is running. Cloud watches continue between sessions; start a new watch after it stops.",
    );
    expect(resumed?.headSha).toBe("");
    expect(
      await startCloudPullRequestWatch(args, {
        enabled: () => true,
        request: async () => {
          throw new ApiRequestError(
            "disabled",
            400,
            JSON.stringify({ errorCode: "CLOUD_WATCH_PR_DISABLED" }),
          );
        },
      }),
    ).toBeUndefined();
    await expect(
      startCloudPullRequestWatch(args, {
        enabled: () => true,
        request: async () => {
          throw new Error("network unavailable");
        },
      }),
    ).rejects.toThrow("network unavailable");
  });
});
