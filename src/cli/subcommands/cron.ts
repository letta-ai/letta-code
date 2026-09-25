/**
 * `letta cron` CLI subcommand.
 *
 * Usage:
 *   letta cron add --prompt <text> --every <interval> [--agent <id>] [--conversation <id>]
 *   letta cron add --prompt <text> --at <time> [--once] [--agent <id>]
 *   letta cron add --prompt <text> --cron <expr> [--agent <id>]
 *   letta cron list [--agent <id>] [--conversation <id>]
 *   letta cron get <id|name>
 *   letta cron runs --id <id>
 *   letta cron delete <id|name>   (alias: remove)
 *   letta cron delete --all [--agent <id>]
 *
 * Schedule ownership follows execution: managed Cloud sandboxes use durable
 * Cloud schedules; user-managed computers and self-hosted runtimes use their
 * local scheduler.
 */

import { parseArgs } from "node:util";
import { ApiRequestError } from "@/backend/api/request";
import {
  type CloudSchedule,
  createCloudSchedule,
  deleteCloudSchedule,
  getCloudSchedule,
  listCloudScheduleHistory,
  listCloudSchedules,
} from "@/backend/api/schedules";
import {
  addTask,
  deleteAllTasks,
  deleteTask,
  getCronRunLogPath,
  getTask,
  isValidCron,
  listTasks,
  parseAt,
  parseEvery,
  readCronRunLogEntriesPage,
} from "@/cron";
import {
  buildCloudScheduleInput,
  CLOUD_EXECUTION_TARGET,
  isManagedCloudSandbox,
  resolveCronCreatePlacement,
} from "@/cron/runner";
import { getRuntimeActingUserId } from "@/runtime-context";
import {
  resolveCronAddConversationTarget,
  resolveCronAgentId,
  resolveCronConversationFilter,
} from "./cron-scope";
import {
  ensureSettingsForCloud,
  printAmbiguousTaskName,
  resolveTaskName,
} from "./cron-task-ref";

// ── Usage ───────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(
    `
Usage:
  letta cron add --prompt <text> --every <interval> [options]
  letta cron add --prompt <text> --at <time> [--once] [options]
  letta cron add --prompt <text> --cron <expr> [options]
  letta cron list [options]
  letta cron get <id|name>
  letta cron runs --id <id> [--limit <n>]
  letta cron delete <id|name>   (alias: remove)
  letta cron delete --all [--agent <id>]

Add options:
  --prompt <text>        Prompt to send to the agent (required)
  --every <interval>     Recurring interval (e.g. 5m, 2h, 1d)
  --at <time>            Scheduled time (e.g. "in 45m", "3:00pm", or an
                         RFC 3339 timestamp with an explicit timezone)
  --once                 Fire once (with --at); default for --at
  --cron <expr>          Raw 5-field cron expression
  --agent <id>           Agent ID (defaults to LETTA_AGENT_ID)
  --conversation <id>    Conversation target (omit or "new" for a fresh
                         conversation per fire; "self" for the current
                         conversation; "default" for the agent default)
  --computer <id>        (managed Cloud sandbox only) Run on a connected
                         external computer (deviceId from \`letta computers
                         list\`). Falls back to the Cloud sandbox if that
                         computer is offline at fire time.

List/filter options:
  --agent <id>           Filter by agent ID
  --conversation <id>    Filter by conversation ID

Delete options:
  --all                  Delete all tasks for the given agent

Output is JSON.
`.trim(),
  );
}

// ── Args ────────────────────────────────────────────────────────────

const CRON_OPTIONS = {
  help: { type: "boolean", short: "h" },
  name: { type: "string" },
  description: { type: "string" },
  prompt: { type: "string" },
  every: { type: "string" },
  at: { type: "string" },
  once: { type: "boolean" },
  cron: { type: "string" },
  agent: { type: "string" },
  conversation: { type: "string" },
  all: { type: "boolean" },
  id: { type: "string" },
  limit: { type: "string" },
  "run-id": { type: "string" },
  computer: { type: "string" },
} as const;

type CronArgValues = ReturnType<typeof parseCronArgs>["values"];

function parseCronArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: CRON_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

// ── Cloud output mapping ────────────────────────────────────────────

function extractPromptFromCloudSchedule(
  schedule: CloudSchedule,
): string | null {
  const messages = schedule.message?.messages;
  if (!Array.isArray(messages)) return null;
  const first = messages[0];
  if (!first || typeof first.content !== "string") return null;
  return first.content;
}

function formatCloudScheduleOutput(
  schedule: CloudSchedule,
): Record<string, unknown> {
  const targetDeviceId = schedule.target_device_id ?? null;
  return {
    id: schedule.id,
    runner: "cloud",
    execution_target: targetDeviceId ?? CLOUD_EXECUTION_TARGET,
    ...(targetDeviceId && { target_device_id: targetDeviceId }),
    agent_id: schedule.agent_id,
    conversation_id: schedule.conversation_id ?? "default",
    name: schedule.name ?? null,
    description: schedule.description ?? null,
    prompt: extractPromptFromCloudSchedule(schedule),
    schedule: schedule.schedule,
    recurring: schedule.schedule.type === "recurring",
    next_scheduled_time: schedule.next_scheduled_time,
    created_at: schedule.created_at ?? null,
  };
}

// ── Handlers ────────────────────────────────────────────────────────

async function handleAdd(values: CronArgValues): Promise<number> {
  const name = values.name;
  if (!name || typeof name !== "string") {
    console.error("Error: --name is required.");
    return 1;
  }

  const description = values.description;
  if (!description || typeof description !== "string") {
    console.error("Error: --description is required.");
    return 1;
  }

  const prompt = values.prompt;
  if (!prompt || typeof prompt !== "string") {
    console.error("Error: --prompt is required.");
    return 1;
  }

  const agentId = resolveCronAgentId(values.agent);
  if (!agentId) {
    console.error("Error: --agent or LETTA_AGENT_ID required.");
    return 1;
  }

  const conversationId = resolveCronAddConversationTarget(values.conversation);
  if (conversationId === null) return 1;

  // Determine schedule type
  const everyValue = values.every;
  const atValue = values.at;
  const cronValue = values.cron;

  const specCount = [everyValue, atValue, cronValue].filter(Boolean).length;
  if (specCount === 0) {
    console.error("Error: one of --every, --at, or --cron is required.");
    return 1;
  }
  if (specCount > 1) {
    console.error("Error: only one of --every, --at, or --cron allowed.");
    return 1;
  }

  let cron: string;
  let recurring: boolean;
  let scheduledFor: Date | undefined;
  let note: string | undefined;

  if (everyValue) {
    const parsed = parseEvery(everyValue);
    if (!parsed) {
      console.error(`Error: invalid interval "${everyValue}". Try: 5m, 2h, 1d`);
      return 1;
    }
    cron = parsed.cron;
    recurring = true;
    note = parsed.note;
  } else if (atValue) {
    const parsed = parseAt(atValue);
    if (!parsed) {
      console.error(
        `Error: invalid time "${atValue}". Try: "in 45m", "3:00pm", or "2026-09-24T09:00:00-07:00"`,
      );
      return 1;
    }
    cron = parsed.cron;
    recurring = false;
    scheduledFor = parsed.scheduledFor;
    note = parsed.note;
  } else if (cronValue) {
    if (!isValidCron(cronValue)) {
      console.error(
        `Error: invalid cron expression "${cronValue}". Needs 5 fields.`,
      );
      return 1;
    }
    if (values.once) {
      console.error(
        "Error: --once cannot be used with --cron. Use --at for one-shot tasks.",
      );
      return 1;
    }
    cron = cronValue;
    recurring = true;
  } else {
    console.error("Error: no schedule specified.");
    return 1;
  }

  const placement = await resolveCronCreatePlacement({
    agentId,
    targetDeviceId: values.computer,
  });
  if ("error" in placement) {
    console.error(`Error: ${placement.error}`);
    return 1;
  }
  const { runner, targetDeviceId } = placement;

  if (runner === "cloud") {
    return handleCloudAdd({
      agentId,
      conversationId,
      name,
      description,
      prompt,
      cron,
      recurring,
      scheduledFor,
      note,
      targetDeviceId,
    });
  }

  try {
    const result = addTask({
      agent_id: agentId,
      conversation_id: conversationId,
      name,
      description,
      cron,
      recurring,
      prompt,
      scheduled_for: scheduledFor,
    });

    const output: Record<string, unknown> = {
      id: result.task.id,
      runner: "local",
      status: result.task.status,
      cron: result.task.cron,
      recurring: result.task.recurring,
      agent_id: result.task.agent_id,
      conversation_id: result.task.conversation_id,
      created_at: result.task.created_at,
    };

    if (result.task.scheduled_for) {
      output.scheduled_for = result.task.scheduled_for;
    }
    if (result.task.expires_at) {
      output.expires_at = result.task.expires_at;
    }
    if (note) {
      output.note = note;
    }
    if (result.warning) {
      output.warning = result.warning;
    }

    console.log(JSON.stringify(output, null, 2));
    console.error(
      "Created local schedule: it only fires while a Letta session is running on this device.",
    );
    return 0;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

interface CloudAddParams {
  agentId: string;
  conversationId: string;
  name: string;
  description: string;
  prompt: string;
  cron: string;
  recurring: boolean;
  scheduledFor?: Date;
  note?: string;
  targetDeviceId?: string;
}

async function handleCloudAdd(params: CloudAddParams): Promise<number> {
  let built: ReturnType<typeof buildCloudScheduleInput>;
  try {
    built = buildCloudScheduleInput({
      name: params.name,
      description: params.description,
      prompt: params.prompt,
      conversationId: params.conversationId,
      cron: params.cron,
      recurring: params.recurring,
      scheduledFor: params.scheduledFor,
      targetDeviceId: params.targetDeviceId,
    });
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  try {
    const result = await createCloudSchedule(
      params.agentId,
      built.input,
      getRuntimeActingUserId(),
    );

    const targetDeviceId =
      result.target_device_id ?? built.input.target_device_id ?? null;

    const output: Record<string, unknown> = {
      id: result.id,
      runner: "cloud",
      execution_target: targetDeviceId ?? CLOUD_EXECUTION_TARGET,
      ...(targetDeviceId && { target_device_id: targetDeviceId }),
      agent_id: params.agentId,
      conversation_id: params.conversationId,
      recurring: params.recurring,
      schedule: built.input.schedule,
      ...(result.next_scheduled_at && {
        next_scheduled_at: result.next_scheduled_at,
      }),
    };

    const notes = [...built.notes];
    if (params.note) notes.unshift(params.note);
    if (notes.length > 0) {
      output.notes = notes;
    }

    console.log(JSON.stringify(output, null, 2));
    console.error(
      targetDeviceId
        ? `Created Cloud schedule: it fires from the cloud and runs on computer "${targetDeviceId}" (sandbox fallback if offline).`
        : "Created Cloud schedule: it fires from the cloud and runs in this agent's managed cloud sandbox (survives local shutdown).",
    );
    return 0;
  } catch (err) {
    // Deliberately no fallback to the local runner: silently degrading to an
    // ephemeral device-local schedule is the failure mode LET-9692 fixes.
    console.error(
      `Error: failed to create Cloud schedule: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error("No schedule was created. Retry the request.");
    return 1;
  }
}

async function handleList(values: CronArgValues): Promise<number> {
  const agentId = values.agent || process.env.LETTA_AGENT_ID || undefined;
  const conversationId = resolveCronConversationFilter(values.conversation);
  if (conversationId === null) return 1;

  if (!isManagedCloudSandbox()) {
    const output = listTasks({
      agent_id: agentId,
      conversation_id: conversationId,
    }).map((task) => ({ ...task, runner: "local" }));
    console.log(JSON.stringify(output, null, 2));
    return 0;
  }

  if (!agentId) {
    console.error(
      "Error: --agent or LETTA_AGENT_ID required to list Cloud schedules.",
    );
    return 1;
  }

  try {
    await ensureSettingsForCloud();
    const response = await listCloudSchedules(agentId);
    const output = response.scheduled_messages
      .filter(
        (schedule) =>
          !conversationId ||
          (schedule.conversation_id ?? "default") === conversationId,
      )
      .map(formatCloudScheduleOutput);
    console.log(JSON.stringify(output, null, 2));
    return 0;
  } catch (err) {
    console.error(
      `Error: Cloud schedules not listed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}

async function handleGet(
  values: CronArgValues,
  positionals: string[],
): Promise<number> {
  const taskRef = positionals[1];
  if (!taskRef) {
    console.error(
      "Error: task ID or name required. Usage: letta cron get <id|name>",
    );
    return 1;
  }

  const agentId = resolveCronAgentId(values.agent);
  if (!isManagedCloudSandbox()) {
    const task = getTask(taskRef);
    if (task) {
      console.log(JSON.stringify({ ...task, runner: "local" }, null, 2));
      return 0;
    }
  } else if (agentId) {
    try {
      await ensureSettingsForCloud();
      const schedule = await getCloudSchedule(agentId, taskRef);
      console.log(JSON.stringify(formatCloudScheduleOutput(schedule), null, 2));
      return 0;
    } catch (err) {
      if (!(err instanceof ApiRequestError && err.status === 404)) {
        console.error(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
        return 1;
      }
    }
  } else {
    console.error(
      "Error: --agent or LETTA_AGENT_ID is required to look up Cloud schedules.",
    );
    return 1;
  }

  const resolved = await resolveTaskName(taskRef, { agentId });
  if (resolved && "ambiguous" in resolved) {
    printAmbiguousTaskName(taskRef, resolved.ambiguous);
    return 1;
  }
  if (resolved?.store === "local") {
    const task = getTask(resolved.id);
    if (task) {
      console.log(JSON.stringify({ ...task, runner: "local" }, null, 2));
      return 0;
    }
  }
  if (resolved?.store === "cloud" && agentId) {
    try {
      const schedule = await getCloudSchedule(agentId, resolved.id);
      console.log(JSON.stringify(formatCloudScheduleOutput(schedule), null, 2));
      return 0;
    } catch {
      // fall through to not-found
    }
  }

  console.error(`Error: task ${taskRef} not found.`);
  return 1;
}

async function handleRuns(values: CronArgValues): Promise<number> {
  const id = values.id;
  if (!id || typeof id !== "string") {
    console.error("Error: --id is required. Usage: letta cron runs --id <id>");
    return 1;
  }

  const limitRaw = Number.parseInt(String(values.limit ?? "50"), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
  const runId = values["run-id"];

  if (!isManagedCloudSandbox() && getTask(id)) {
    try {
      const logPath = getCronRunLogPath(id);
      const page = readCronRunLogEntriesPage(logPath, {
        jobId: id,
        limit,
        ...(typeof runId === "string" && runId.trim() ? { runId } : {}),
      });
      console.log(JSON.stringify(page, null, 2));
      return 0;
    } catch (err) {
      console.error(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

  if (!isManagedCloudSandbox()) {
    console.error(`Error: task ${id} not found.`);
    return 1;
  }

  const agentId = resolveCronAgentId(values.agent);
  if (!agentId) {
    console.error(
      `Error: --agent or LETTA_AGENT_ID is required to look up Cloud schedule runs for task ${id}.`,
    );
    return 1;
  }

  try {
    await ensureSettingsForCloud();
    const response = await listCloudScheduleHistory(agentId, id, { limit });
    console.log(
      JSON.stringify(
        {
          runner: "cloud",
          entries: response.history,
          has_next_page: response.has_next_page,
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function handleDelete(
  values: CronArgValues,
  positionals: string[],
): Promise<number> {
  if (values.all) {
    return handleDeleteAll(values);
  }

  const taskRef = positionals[1];
  if (!taskRef) {
    console.error(
      "Error: task ID or name required. Usage: letta cron delete <id|name> or --all --agent <id>",
    );
    return 1;
  }

  if (!isManagedCloudSandbox()) {
    const found = deleteTask(taskRef);
    if (found) {
      console.log(JSON.stringify({ deleted: taskRef, runner: "local" }));
      return 0;
    }
  }

  const agentId = resolveCronAgentId(values.agent);

  if (isManagedCloudSandbox()) {
    if (!agentId) {
      console.error(
        `Error: --agent or LETTA_AGENT_ID is required to delete Cloud schedule ${taskRef}.`,
      );
      return 1;
    }
    try {
      await ensureSettingsForCloud();
      // Verify existence first: the cloud delete endpoint is a soft-delete
      // update that reports success even for unknown IDs.
      await getCloudSchedule(agentId, taskRef);
      await deleteCloudSchedule(agentId, taskRef);
      console.log(JSON.stringify({ deleted: taskRef, runner: "cloud" }));
      return 0;
    } catch (err) {
      if (!(err instanceof ApiRequestError && err.status === 404)) {
        console.error(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
        return 1;
      }
      // 404 → not an ID; fall through to name resolution.
    }
  }

  // Not an ID in either store — try it as a task name (LET-10492): `add`
  // requires --name, so the name is the handle users actually remember.
  const resolved = await resolveTaskName(taskRef, { agentId });
  if (resolved && "ambiguous" in resolved) {
    printAmbiguousTaskName(taskRef, resolved.ambiguous);
    return 1;
  }
  if (resolved?.store === "local" && deleteTask(resolved.id)) {
    console.log(
      JSON.stringify({ deleted: resolved.id, name: taskRef, runner: "local" }),
    );
    return 0;
  }
  if (resolved?.store === "cloud" && agentId) {
    try {
      await deleteCloudSchedule(agentId, resolved.id);
      console.log(
        JSON.stringify({
          deleted: resolved.id,
          name: taskRef,
          runner: "cloud",
        }),
      );
      return 0;
    } catch (err) {
      console.error(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

  console.error(`Error: task ${taskRef} not found.`);
  return 1;
}

async function handleDeleteAll(values: CronArgValues): Promise<number> {
  const agentId = resolveCronAgentId(values.agent);
  if (!agentId) {
    console.error("Error: --agent or LETTA_AGENT_ID required with --all.");
    return 1;
  }

  let localDeleted = 0;
  let cloudDeleted = 0;
  if (!isManagedCloudSandbox()) {
    localDeleted = deleteAllTasks(agentId);
  } else {
    try {
      const response = await listCloudSchedules(agentId);
      for (const schedule of response.scheduled_messages) {
        await deleteCloudSchedule(agentId, schedule.id);
        cloudDeleted += 1;
      }
    } catch (err) {
      console.error(
        `Error: failed to delete Cloud schedules: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error(`Deleted so far: ${cloudDeleted} cloud.`);
      return 1;
    }
  }

  console.log(
    JSON.stringify({
      deleted: localDeleted + cloudDeleted,
      local_deleted: localDeleted,
      cloud_deleted: cloudDeleted,
      agent_id: agentId,
    }),
  );
  return 0;
}

// ── Entry ───────────────────────────────────────────────────────────

export async function runCronSubcommand(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseCronArgs>;
  try {
    parsed = parseCronArgs(argv);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    printUsage();
    return 1;
  }

  const [action] = parsed.positionals;
  if (parsed.values.help || !action || action === "help") {
    printUsage();
    return 0;
  }

  switch (action) {
    case "add":
      return handleAdd(parsed.values);
    case "list":
      return handleList(parsed.values);
    case "get":
      return handleGet(parsed.values, parsed.positionals);
    case "runs":
      return handleRuns(parsed.values);
    case "delete":
    // "remove" reads naturally enough that agents/scripts reach for it, and
    // the old "Unknown action" + usage dump was easy to misread as success
    // in captured output (LET-10492).
    case "remove":
      return handleDelete(parsed.values, parsed.positionals);
    default:
      console.error(`Unknown action: ${action}`);
      printUsage();
      return 1;
  }
}
