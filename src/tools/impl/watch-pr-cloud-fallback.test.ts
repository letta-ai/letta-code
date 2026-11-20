import { expect, test } from "bun:test";
import { ApiRequestError } from "@/backend/api/request";
import { startCloudPullRequestWatch } from "./watch-pr-cloud";

const args = {
  url: "https://github.com/example/repo/pull/1",
  parentScope: { agentId: "agent-1", conversationId: "conv-1" },
};

test("falls back on transient create failures while preserving other errors and resumes", async () => {
  for (const [status, body] of [
    [400, JSON.stringify({ errorCode: "PR_SNAPSHOT_UNAVAILABLE" })],
    [500, "internal error"],
    [502, "bad gateway"],
    [503, "unavailable"],
    [599, "server error"],
  ] as const) {
    const error = new ApiRequestError("create failed", status, body);
    const request = async () => {
      throw error;
    };
    expect(
      await startCloudPullRequestWatch(args, {
        enabled: () => true,
        request,
      }),
    ).toBeUndefined();
    await expect(
      startCloudPullRequestWatch(
        { ...args, resume: "cmon-1" },
        {
          enabled: () => true,
          request,
        },
      ),
    ).rejects.toBe(error);
  }
  for (const [status, body] of [
    [400, JSON.stringify({ errorCode: "PR_NOT_OPEN" })],
    [400, "malformed"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "too many requests"],
  ] as const) {
    const error = new ApiRequestError("create failed", status, body);
    await expect(
      startCloudPullRequestWatch(args, {
        enabled: () => true,
        request: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
  }
});
