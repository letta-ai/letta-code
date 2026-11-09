import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  clearAllSubagents,
  clearCompletedSubagents,
  completeSubagent,
  registerSubagent,
  updateSubagent,
} from "@/agent/subagent-state";
import { INTERRUPTED_BY_USER } from "@/constants";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  caller,
  sendAgentMessageFixture,
} from "@/test-utils/send-agent-message-fixture";
import { list_subagents } from "./list-subagents";
import { backgroundTasks, createBackgroundOutputFile } from "./process_manager";
import { send_agent_message } from "./send-agent-message";
import { task_stop } from "./task-stop";

const PARENT = { agentId: "agent-parent", conversationId: "conv-parent" };
const scope = () => PARENT;

function launch(
  id: string,
  type: string,
  description: string,
  parent: { agentId: string; conversationId: string } = PARENT,
) {
  registerSubagent(id, type, description, `call-${id}`, true, false, parent);
}

beforeEach(() => clearAllSubagents());
afterEach(() => {
  setSystemTime();
  backgroundTasks.clear();
  clearAllSubagents();
});

const EPHEMERAL_CONV = "conv-66666666-6666-4666-8666-666666666666";

/**
 * A fresh Cloud subagent in an ephemeral conversation: the child's init event
 * carries a conversation ID and no agent ID, so the row never gets one.
 */
function launchEphemeral(id: string, taskId: string) {
  launch(id, "general-purpose", "Audit the logs");
  updateSubagent(id, { taskId });
  updateSubagent(id, { conversationId: EPHEMERAL_CONV });
}

test("lists nothing before any agent is launched", async () => {
  expect(await list_subagents({}, { scope })).toEqual({ agents: [] });
});

test("lists a background Letta subagent and an external worker with their addresses", async () => {
  launch("sub-1", "general-purpose", "Review the diff");
  updateSubagent("sub-1", {
    agentId: "agent-child",
    conversationId: "conv-child",
    agentURL: "https://app.example/agents/agent-child",
    taskId: "task_1",
  });
  launch("sub-2", "claude-code", "Fix the flaky test");
  updateSubagent("sub-2", {
    agentId: "claude_6062e098-ab3f-4e98-a474-f1020b0a79cb@laptop",
    status: "running",
    taskId: "task_2",
  });

  const { agents } = await list_subagents({}, { scope });
  expect(agents).toHaveLength(2);
  const [external, letta] = [...agents].sort((a, b) =>
    a.type.localeCompare(b.type),
  );
  expect(letta).toMatchObject({
    name: "Review the diff",
    type: "General-purpose",
    agent_id: "agent-child",
    conversation_id: "conv-child",
    task_id: "task_1",
    status: "running",
  });
  expect(external).toMatchObject({
    name: "Fix the flaky test",
    agent_id: "claude_6062e098-ab3f-4e98-a474-f1020b0a79cb@laptop",
    task_id: "task_2",
    status: "running",
    computer: "laptop",
  });
  expect(external).not.toHaveProperty("conversation_id");
});

test("keeps finished agents after the live store drops them as idle, with a failed run's error", async () => {
  for (const id of ["done", "broken", "interrupted", "stopped"]) {
    launch(id, "general-purpose", id);
    updateSubagent(id, {
      agentId: `agent-${id}`,
      conversationId: `conv-${id}`,
      agentURL: "x",
    });
  }
  completeSubagent("done", { success: true });
  completeSubagent("broken", { success: false, error: "model error" });
  completeSubagent("interrupted", {
    success: false,
    error: INTERRUPTED_BY_USER,
  });
  updateSubagent("stopped", { stoppedByCaller: true });
  completeSubagent("stopped", { success: false, error: "aborted" });
  clearCompletedSubagents();

  const byName = Object.fromEntries(
    (await list_subagents({ status: ["idle"] }, { scope })).agents.map((a) => [
      a.name,
      a,
    ]),
  );
  expect(Object.keys(byName).sort()).toEqual([
    "broken",
    "done",
    "interrupted",
    "stopped",
  ]);
  expect(byName.done?.status).toBe("idle");
  expect(byName.done).not.toHaveProperty("error");
  expect(byName.broken).toMatchObject({
    status: "idle",
    error: "model error",
  });
  expect(byName.interrupted?.status).toBe("idle");
  expect(byName.stopped?.status).toBe("idle");
});

test("a follow-up send to a finished child shows as one row with the latest status", async () => {
  launch("first", "general-purpose", "Draft the PR");
  updateSubagent("first", {
    agentId: "agent-child",
    conversationId: "conv-child",
    agentURL: "x",
    taskId: "task_1",
  });
  completeSubagent("first", { success: true });
  // trackChildSend registers a new row for the follow-up turn.
  launch("followup", "general-purpose", "follow-up");
  updateSubagent("followup", {
    agentId: "agent-child",
    conversationId: "conv-child",
    agentURL: "x",
  });

  const { agents } = await list_subagents({}, { scope });
  expect(agents).toHaveLength(1);
  expect(agents[0]).toMatchObject({
    name: "Draft the PR",
    status: "running",
    task_id: "task_1",
  });
});

test("lists an ephemeral-conversation subagent by its conversation ID, live and finished", async () => {
  launchEphemeral("eph", "task_eph");
  const live = (await list_subagents({}, { scope })).agents;
  expect(live).toEqual([
    expect.objectContaining({
      name: "Audit the logs",
      agent_id: null,
      conversation_id: EPHEMERAL_CONV,
      task_id: "task_eph",
      status: "running",
    }),
  ]);

  completeSubagent("eph", { success: true });
  clearCompletedSubagents();
  const finished = (await list_subagents({ status: ["idle"] }, { scope }))
    .agents;
  expect(finished).toHaveLength(1);
  expect(finished[0]).toMatchObject({
    agent_id: null,
    conversation_id: EPHEMERAL_CONV,
    status: "idle",
  });
});

test("resuming an ephemeral conversation keeps one row", async () => {
  launchEphemeral("eph", "task_eph");
  completeSubagent("eph", { success: true });
  // Agent with conversation_id deploys the same agentless conversation again.
  launch("resume", "general-purpose", "resume");
  updateSubagent("resume", {
    agentId: undefined,
    conversationId: EPHEMERAL_CONV,
    taskId: "task_resume",
  });

  const { agents } = await list_subagents({}, { scope });
  expect(agents).toHaveLength(1);
  expect(agents[0]).toMatchObject({
    name: "Audit the logs",
    agent_id: null,
    conversation_id: EPHEMERAL_CONV,
    task_id: "task_resume",
    status: "running",
  });
});

test("SendAgentMessage and TaskStop accept an ephemeral row's IDs as listed", async () => {
  launchEphemeral("eph", "task_eph");
  const abortController = new AbortController();
  backgroundTasks.set("task_eph", {
    description: "Audit the logs",
    subagentType: "general-purpose",
    subagentId: "eph",
    status: "running",
    startTime: new Date(),
    outputFile: createBackgroundOutputFile("task_eph"),
    abortController,
    completion: Promise.resolve(),
  });
  const [row] = (await list_subagents({}, { scope })).agents;
  if (!row?.conversation_id || !row.task_id) throw new Error("no address");

  const f = sendAgentMessageFixture();
  const sent = await runWithRuntimeContext(caller, () =>
    send_agent_message(
      {
        ...(row.agent_id ? { agent_id: row.agent_id } : {}),
        conversation_id: row.conversation_id,
        message: "Also check the error rate.",
      },
      f,
    ),
  );
  expect(sent.status).toBe("success");
  expect(f.submissions).toHaveLength(1);
  expect(f.submissions[0]?.conversationId).toBe(EPHEMERAL_CONV);
  expect(f.submissions[0]?.agentId).toBeUndefined();

  expect(await task_stop({ task_id: row.task_id })).toEqual({ killed: true });
  expect(abortController.signal.aborted).toBe(true);
  // The aborted run settles and the row goes idle.
  completeSubagent("eph", { success: false, error: "aborted" });
  expect(
    (await list_subagents({ status: ["idle"] }, { scope })).agents[0]?.status,
  ).toBe("idle");
});

test("omits other conversations' children and memory workers", async () => {
  launch("mine", "general-purpose", "mine");
  launch("theirs", "general-purpose", "theirs", {
    agentId: "agent-parent",
    conversationId: "conv-other",
  });
  launch("memory", "memory", "memory upkeep");

  const { agents } = await list_subagents({}, { scope });
  expect(agents.map((a) => a.name)).toEqual(["mine"]);
});

test("lists the most recently active agent first, even if it started earlier", async () => {
  setSystemTime(new Date("2026-01-01T00:00:00Z"));
  launch("older", "general-purpose", "older");
  setSystemTime(new Date("2026-01-01T00:01:00Z"));
  launch("newer", "general-purpose", "newer");
  setSystemTime(new Date("2026-01-01T00:02:00Z"));
  updateSubagent("older", { taskId: "task_older" });

  const { agents } = await list_subagents({}, { scope });
  expect(agents.map((a) => a.name)).toEqual(["older", "newer"]);
  expect(agents[0]?.started_at).toBe("2026-01-01T00:00:00.000Z");
  expect(agents[0]?.last_activity_at).toBe("2026-01-01T00:02:00.000Z");
});

test("breaks last-activity ties by the newest start", async () => {
  setSystemTime(new Date("2026-01-01T00:00:00Z"));
  launch("older", "general-purpose", "older");
  setSystemTime(new Date("2026-01-01T00:01:00Z"));
  launch("newer", "general-purpose", "newer");
  updateSubagent("older", { taskId: "task_older" });

  const { agents } = await list_subagents({}, { scope });
  expect(agents.map((a) => a.name)).toEqual(["newer", "older"]);
});

/** One running child and one finished child per way of ending. */
function launchOnePerStatus() {
  for (const id of ["run", "done", "broken", "halted"]) {
    launch(id, "general-purpose", id);
    updateSubagent(id, {
      agentId: `agent-${id}`,
      conversationId: `conv-${id}`,
      agentURL: "x",
    });
  }
  completeSubagent("done", { success: true });
  completeSubagent("broken", { success: false, error: "model error" });
  updateSubagent("halted", { stoppedByCaller: true });
  completeSubagent("halted", { success: false, error: "aborted" });
}

const names = (agents: { name: string }[]) => agents.map((a) => a.name).sort();

test("status filters to running agents", async () => {
  launchOnePerStatus();
  const { agents } = await list_subagents({ status: ["running"] }, { scope });
  expect(agents).toEqual([
    expect.objectContaining({ name: "run", status: "running" }),
  ]);
});

test("idle lists completed, failed and stopped agents", async () => {
  launchOnePerStatus();
  const { agents } = await list_subagents({ status: ["idle"] }, { scope });
  expect(names(agents)).toEqual(["broken", "done", "halted"]);
  expect(agents.every((a) => a.status === "idle")).toBe(true);
});

test("omitting status lists only running agents", async () => {
  launchOnePerStatus();
  const { agents } = await list_subagents({}, { scope });
  expect(agents).toEqual([
    expect.objectContaining({ name: "run", status: "running" }),
  ]);
});

test("passing both statuses lists every agent", async () => {
  launchOnePerStatus();
  const { agents } = await list_subagents(
    { status: ["running", "idle"] },
    { scope },
  );
  expect(names(agents)).toEqual(["broken", "done", "halted", "run"]);
});

test("status filters after merging rows, on the latest status", async () => {
  launch("first", "general-purpose", "Draft the PR");
  updateSubagent("first", {
    agentId: "agent-child",
    conversationId: "conv-child",
    agentURL: "x",
  });
  completeSubagent("first", { success: true });
  launch("followup", "general-purpose", "follow-up");
  updateSubagent("followup", {
    agentId: "agent-child",
    conversationId: "conv-child",
    agentURL: "x",
  });

  expect(
    (await list_subagents({ status: ["idle"] }, { scope })).agents,
  ).toEqual([]);
  expect(
    (await list_subagents({ status: ["running"] }, { scope })).agents,
  ).toEqual([expect.objectContaining({ name: "Draft the PR" })]);
});

test("status filters an agentless row the same way", async () => {
  launchEphemeral("eph", "task_eph");
  expect(
    (await list_subagents({ status: ["running"] }, { scope })).agents,
  ).toEqual([
    expect.objectContaining({
      agent_id: null,
      conversation_id: EPHEMERAL_CONV,
      status: "running",
    }),
  ]);
  expect(
    (await list_subagents({ status: ["idle"] }, { scope })).agents,
  ).toEqual([]);

  updateSubagent("eph", { stoppedByCaller: true });
  completeSubagent("eph", { success: false, error: "aborted" });
  expect(
    (await list_subagents({ status: ["idle"] }, { scope })).agents,
  ).toEqual([
    expect.objectContaining({
      agent_id: null,
      conversation_id: EPHEMERAL_CONV,
      status: "idle",
    }),
  ]);
  expect(
    (await list_subagents({ status: ["running"] }, { scope })).agents,
  ).toEqual([]);
});

test("an unknown status errors and lists the valid values", async () => {
  await expect(
    list_subagents({ status: ["running", "completed"] as never }, { scope }),
  ).rejects.toThrow('Unknown status "completed"; valid values: running, idle');
  await expect(
    list_subagents({ status: "running" as never }, { scope }),
  ).rejects.toThrow("status must be an array of: running, idle");
});

test("an empty status array errors instead of matching nothing", async () => {
  await expect(list_subagents({ status: [] }, { scope })).rejects.toThrow(
    "status must list at least one of: running, idle. Omit it to list running agents.",
  );
});
