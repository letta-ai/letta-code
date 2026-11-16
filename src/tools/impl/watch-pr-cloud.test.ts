import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "@/backend/api/request";
import { startCloudPullRequestWatch } from "./watch-pr-cloud";

const args = {
  url: "https://github.com/example/repo/pull/1",
  notify_on: ["state" as const],
  parentScope: { agentId: "agent-1", conversationId: "conv-1" },
};
describe("cloud WatchPR registration", () => {
  test("registers with filters and falls back only when the repository is inaccessible", async () => {
    const calls: unknown[] = [];
    const result = await startCloudPullRequestWatch(args, {
      enabled: () => true,
      request: async (...call: unknown[]) => {
        calls.push(call);
        return { id: "cmon-1" } as never;
      },
    });
    expect(result?.taskId).toBe("cmon-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject([
      "POST",
      "/v1/conversations/conv-1/cloud-monitors",
      {
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
    expect(resumed?.content[0]?.text).toContain("running");
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
