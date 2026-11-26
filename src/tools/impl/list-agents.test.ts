import { expect, spyOn, test } from "bun:test";
import {
  clearSubagentsByIds,
  completeSubagent,
  registerSubagent,
} from "@/agent/subagent-state";
import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { list_agents } from "./list-agents";

const scope = { agentId: "agent-list", conversationId: "conv-list" };

test("local pages use lifecycle recency and apply status and conversation scope", async () => {
  const previousUrl = process.env.LETTA_BASE_URL;
  process.env.LETTA_BASE_URL = "http://localhost:8283";
  const clock = spyOn(Date, "now");
  const ids = ["list-a", "list-b", "list-z", "list-other", "list-running"];
  try {
    clock.mockReturnValue(1);
    for (const id of ids) {
      registerSubagent(id, "ordinary", id, undefined, false, false, {
        ...scope,
        conversationId:
          id === "list-other" ? "conv-other" : scope.conversationId,
      });
    }
    clock.mockReturnValue(2);
    completeSubagent("list-z", { success: true });
    clock.mockReturnValue(3);
    for (const id of ["list-a", "list-b", "list-other"]) {
      completeSubagent(id, { success: true });
    }
    const list = (cursor?: string) =>
      runWithRuntimeContext(scope, () =>
        list_agents({ limit: 1, status: "completed", cursor }),
      );

    expect(await list()).toMatchObject({
      agents: [
        {
          subagent_id: "list-b",
          created_at: "1970-01-01T00:00:00.001Z",
          updated_at: "1970-01-01T00:00:00.003Z",
        },
      ],
      has_more: true,
      next_cursor: "list-b",
    });
    expect(await list("list-b")).toMatchObject({
      agents: [{ subagent_id: "list-a" }],
      has_more: true,
      next_cursor: "list-a",
    });
    expect(await list("list-a")).toMatchObject({
      agents: [{ subagent_id: "list-z" }],
      has_more: false,
      next_cursor: null,
    });
  } finally {
    clock.mockRestore();
    clearSubagentsByIds(ids);
    if (previousUrl === undefined) delete process.env.LETTA_BASE_URL;
    else process.env.LETTA_BASE_URL = previousUrl;
  }
});

test("Cloud requests one page with one extra row and returns the last visible ID", async () => {
  await settingsManager.initialize();
  const previousUrl = process.env.LETTA_BASE_URL;
  const previousLocal = process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
  process.env.LETTA_BASE_URL = LETTA_CLOUD_API_URL;
  delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      ["newer", "older"].map((subagent_id) => ({
        subagent_id,
        status: "running",
        worker_session_id: `codex_${subagent_id}`,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
      })),
    ),
  );
  try {
    expect(
      await runWithRuntimeContext(scope, () =>
        list_agents({ limit: 1, cursor: "previous", status: "running" }),
      ),
    ).toMatchObject({
      agents: [
        {
          subagent_id: "newer",
          agent_id: "codex_newer",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-02T00:00:00.000Z",
        },
      ],
      has_more: true,
      next_cursor: "newer",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(request.pathname).toBe("/v1/subagents");
    expect(Object.fromEntries(request.searchParams)).toEqual({
      parent_conversation_id: scope.conversationId,
      archived: "false",
      after: "previous",
      limit: "2",
      status: "running",
    });
  } finally {
    fetch.mockRestore();
    if (previousUrl === undefined) delete process.env.LETTA_BASE_URL;
    else process.env.LETTA_BASE_URL = previousUrl;
    if (previousLocal === undefined)
      delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
    else process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = previousLocal;
  }
});
