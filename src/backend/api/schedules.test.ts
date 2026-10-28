import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "@/backend/api/request";
import {
  type CloudSchedule,
  type ListCloudSchedulesOptions,
  listCloudSchedulesByExactMatch,
} from "./schedules";

function schedule(overrides: Partial<CloudSchedule> = {}): CloudSchedule {
  return {
    id: "schedule-match",
    agent_id: "agent-test",
    name: "daily report",
    conversation_id: "conv-current",
    message: {},
    schedule: { type: "recurring", cron_expression: "0 9 * * *" },
    next_scheduled_time: null,
    use_sandbox: true,
    ...overrides,
  };
}

type ListRequest = (
  agentId: string,
  options?: ListCloudSchedulesOptions,
) => Promise<{
  scheduled_messages: CloudSchedule[];
  has_next_page: boolean;
}>;

describe("listCloudSchedulesByExactMatch", () => {
  test("uses exact name and conversation filters on the fast path", async () => {
    const calls: Array<ListCloudSchedulesOptions | undefined> = [];
    const request: ListRequest = async (_agentId, options) => {
      calls.push(options);
      return { scheduled_messages: [schedule()], has_next_page: false };
    };

    expect(
      await listCloudSchedulesByExactMatch(
        "agent-test",
        { name: "daily report", conversationId: "conv-current" },
        request,
      ),
    ).toEqual([schedule()]);
    expect(calls).toEqual([
      {
        limit: 100,
        name: "daily report",
        conversationId: "conv-current",
      },
    ]);
  });

  test("falls back to unfiltered pagination when an ignored filter is exposed on a later page", async () => {
    const calls: Array<ListCloudSchedulesOptions | undefined> = [];
    const request: ListRequest = async (_agentId, options = {}) => {
      calls.push(options);
      if (options.name) {
        if (!options.after) {
          return {
            scheduled_messages: [schedule({ id: "filtered-first" })],
            has_next_page: true,
          };
        }
        return {
          scheduled_messages: [
            schedule({ id: "evidence", name: "different name" }),
          ],
          has_next_page: false,
        };
      }
      if (!options.after) {
        return {
          scheduled_messages: [
            schedule({ id: "unrelated", name: "different name" }),
          ],
          has_next_page: true,
        };
      }
      return {
        scheduled_messages: [schedule({ id: "legacy-match" })],
        has_next_page: false,
      };
    };

    const result = await listCloudSchedulesByExactMatch(
      "agent-test",
      { name: "daily report" },
      request,
    );

    expect(result.map(({ id }) => id)).toEqual(["legacy-match"]);
    expect(calls).toEqual([
      { limit: 100, name: "daily report" },
      { limit: 100, after: "filtered-first", name: "daily report" },
      { limit: 100 },
      { limit: 100, after: "unrelated" },
    ]);
  });

  test("keeps default-conversation lookup on the legacy path so NULL-backed schedules are included", async () => {
    const calls: Array<ListCloudSchedulesOptions | undefined> = [];
    const request: ListRequest = async (_agentId, options) => {
      calls.push(options);
      return {
        scheduled_messages: [
          schedule({ id: "null-default", conversation_id: null }),
          schedule({ id: "other", conversation_id: "conv-other" }),
        ],
        has_next_page: false,
      };
    };

    const result = await listCloudSchedulesByExactMatch(
      "agent-test",
      { conversationId: "default" },
      request,
    );

    expect(result.map(({ id }) => id)).toEqual(["null-default"]);
    expect(calls).toEqual([{ limit: 100 }]);
  });

  test("falls back when an older server rejects filters but propagates unrelated errors", async () => {
    let calls = 0;
    const compatibleFallback: ListRequest = async (_agentId, options = {}) => {
      calls += 1;
      if (options.name) {
        throw new ApiRequestError("unknown query parameter", 400, "");
      }
      return { scheduled_messages: [schedule()], has_next_page: false };
    };
    expect(
      await listCloudSchedulesByExactMatch(
        "agent-test",
        { name: "daily report" },
        compatibleFallback,
      ),
    ).toHaveLength(1);
    expect(calls).toBe(2);

    const unavailable = new ApiRequestError("unavailable", 503, "");
    await expect(
      listCloudSchedulesByExactMatch(
        "agent-test",
        { name: "daily report" },
        async () => {
          throw unavailable;
        },
      ),
    ).rejects.toBe(unavailable);
  });
});
