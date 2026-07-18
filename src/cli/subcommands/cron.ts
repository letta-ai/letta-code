/**
 * `letta cron` CLI subcommand.
 *
 * Usage:
 *   letta cron add --prompt <text> --every <interval> [--agent <id>] [--conversation <id>] [--runner local|cloud]
 *   letta cron add --prompt <text> --at <time> [--once] [--agent <id>] [--runner local|cloud]
 *   letta cron add --prompt <text> --cron <expr> [--agent <id>] [--runner local|cloud]
 *   letta cron list [--agent <id>] [--conversation <id>] [--runner local|cloud]
 *   letta cron get <id> [--runner local|cloud]
 *   letta cron runs --id <id> [--runner local|cloud]
 *   letta cron delete <id> [--runner local|cloud]
 *   letta cron delete --all [--agent <id>] [--runner local|cloud]
 *
 * Runners (LET-9692):
 * - "cloud" (default for cloud agents): durable Cloud schedules stored by the
 *   Letta API and executed in the agent's managed cloud sandbox.
 * - "local": runtime-local tasks in ~/.letta/crons.json, executed by the WS
 *   listener on this device. Default for local-backend agents and self-hosted
 *   servers; explicit opt-in (--runner local) for schedules that must run on
 *   this specific machine.
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
import { resolveBackendMode } from "@/backend/backend-mode";
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
  type CronRunner,
  resolveCronRunner,
} from "./cron-runner";

// ── Usage ───────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(
    `
Usage:
  letta cron add --prompt <text> --every <interval> [options]
  letta cron add --prompt <text> --at <time> [--once] [options]
  letta cron add --prompt <text> --cron <expr> [options]
  letta cron list [options]
  letta cron get <id> [--runner local|cloud]
  letta cron runs --id <id> [--limit <n>] [--runner local|cloud]
  letta cron delete <id> [--runner local|cloud]
  letta cron delete --all [--agent <id>] [--runner local|cloud]

Add options:
  --prompt <text>        Prompt to send to the agent (required)
  --every <interval>     Recurring interval (e.g. 5m, 2h, 1d)
  --at <time>            Scheduled time (e.g. "3:00pm", "in 45m")
  --once                 Fire once (with --at); default for --at
  --cron <expr>          Raw 5-field cron expression
  --agent <id>           Agent ID (defaults to LETTA_AGENT_ID)
  --conversation <id>    Conversation ID (defaults to LETTA_CONVERSATION_ID or "default")
  --runner <runner>      Where the schedule lives and fires:
                           cloud - durable Cloud schedule; executes in the
                                   agent's managed cloud sandbox (default for
                                   cloud agents)
                           local - this device's scheduler (~/.letta/crons.json);
                                   only fires while a session runs here (default
                                   for local-backend agents / self-hosted)

List/filter options:
  --agent <id>           Filter by agent ID
  --conversation <id>    Filter by conversation ID
  --runner <runner>      Only show tasks owned by this runner

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
  runner: { type: "string" },
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

function getAgentId(fromArgs?: string): string {
  return fromArgs || process.env.LETTA_AGENT_ID || "";
}

function getConversationId(fromArgs?: string): string {
  return fromArgs || process.env.LETTA_CONVERSATION_ID || "default";
}

// ── Runner resolution ───────────────────────────────────────────────

/**
 * Probe whether the configured server serves the Cloud schedule routes.
 * Managed sandboxes and Desktop sessions point LETTA_BASE_URL at a localhost
 * proxy that forwards to the Letta API, so this is a capability probe rather
 * than a URL-shape check. A 404/405 means the route doesn't exist (self-hosted
 * OSS core); any other response (including auth errors) means the route is
 * there and real requests will surface their own errors.
 */
async function probeCloudScheduleSupport(agentId: string): Promise<boolean> {
  try {
    await listCloudSchedules(agentId, { limit: 1 });
    return true;
  } catch (err) {
    if (
      err instanceof ApiRequestError &&
      (err.status === 404 || err.status === 405)
    ) {
      return false;
    }
    return true;
  }
}

/**
 * The local runner path never needs settings, so the cron subcommand does not
 * initialize them upfront; every cloud API call does (server URL + auth).
 * Idempotent — safe to call before each cloud request.
 */
async function ensureSettingsForCloud(): Promise<void> {
  const { settingsManager } = await import("@/settings-manager");
  await settingsManager.initialize();
}

async function getRunnerForAgent(
  explicit: string | undefined,
  agentId: string,
): Promise<{ runner: CronRunner; reason: string } | { error: string }> {
  const backendMode = resolveBackendMode();

  // Cheap pass first: explicit local, local-backend agents, and invalid flag
  // values resolve without touching settings or the network.
  const preliminary = resolveCronRunner({ explicit, agentId, backendMode });
  if ("error" in preliminary || preliminary.runner === "local") {
    return preliminary;
  }

  await ensureSettingsForCloud();
  const cloudSchedulesSupported = await probeCloudScheduleSupport(agentId);
  return resolveCronRunner({
    explicit,
    agentId,
    backendMode,
    cloudSchedulesSupported,
  });
}

function isRunnerFlagValid(value: string | undefined): boolean {
  return value === undefined || value === "local" || value === "cloud";
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
  return {
    id: schedule.id,
    runner: "cloud",
    execution_target: CLOUD_EXECUTION_TARGET,
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

  const agentId = getAgentId(values.agent);
  if (!agentId) {
    console.error("Error: --agent or LETTA_AGENT_ID required.");
    return 1;
  }

  const conversationId = getConversationId(values.conversation);

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
        `Error: invalid time "${atValue}". Try: "3:00pm", "in 45m"`,
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

  const resolved = await getRunnerForAgent(values.runner, agentId);
  if ("error" in resolved) {
    console.error(`Error: ${resolved.error}`);
    return 1;
  }

  if (resolved.runner === "cloud") {
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
    });
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  try {
    const result = await createCloudSchedule(params.agentId, built.input);

    const output: Record<string, unknown> = {
      id: result.id,
      runner: "cloud",
      execution_target: CLOUD_EXECUTION_TARGET,
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
      "Created Cloud schedule: it fires from the cloud and runs in this agent's managed cloud sandbox (survives local shutdown).",
    );
    return 0;
  } catch (err) {
    // Deliberately no fallback to the local runner: silently degrading to an
    // ephemeral device-local schedule is the failure mode LET-9692 fixes.
    console.error(
      `Error: failed to create Cloud schedule: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      "No schedule was created. Retry, or pass --runner local to schedule on this device instead.",
    );
    return 1;
  }
}

async function handleList(values: CronArgValues): Promise<number> {
  if (!isRunnerFlagValid(values.runner)) {
    console.error(
      `Error: invalid --runner "${values.runner}". Expected "local" or "cloud".`,
    );
    return 1;
  }

  const agentId = values.agent || process.env.LETTA_AGENT_ID || undefined;
  const conversationId = values.conversation || undefined;

  const includeLocal = values.runner !== "cloud";
  const includeCloud = values.runner !== "local";

  const output: Array<Record<string, unknown>> = [];

  if (includeLocal) {
    const tasks = listTasks({
      agent_id: agentId,
      conversation_id: conversationId,
    });
    for (const task of tasks) {
      output.push({ ...task, runner: "local" });
    }
  }

  if (includeCloud && agentId) {
    const resolved = await getRunnerForAgent(undefined, agentId);
    const cloudCapable = !("error" in resolved) && resolved.runner === "cloud";
    const cloudExplicit = values.runner === "cloud";

    if (cloudCapable || cloudExplicit) {
      try {
        const response = await listCloudSchedules(agentId);
        for (const schedule of response.scheduled_messages) {
          if (
            conversationId &&
            (schedule.conversation_id ?? "default") !== conversationId
          ) {
            continue;
          }
          output.push(formatCloudScheduleOutput(schedule));
        }
      } catch (err) {
        console.error(
          `Warning: failed to list Cloud schedules: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (cloudExplicit) {
          return 1;
        }
      }
    }
  } else if (includeCloud && values.runner === "cloud" && !agentId) {
    console.error(
      "Error: --agent or LETTA_AGENT_ID required to list Cloud schedules.",
    );
    return 1;
  }

  console.log(JSON.stringify(output, null, 2));
  return 0;
}

async function handleGet(
  values: CronArgValues,
  positionals: string[],
): Promise<number> {
  if (!isRunnerFlagValid(values.runner)) {
    console.error(
      `Error: invalid --runner "${values.runner}". Expected "local" or "cloud".`,
    );
    return 1;
  }

  const taskId = positionals[1];
  if (!taskId) {
    console.error("Error: task ID required. Usage: letta cron get <id>");
    return 1;
  }

  // Local store is a cheap file read; check it first unless --runner cloud.
  if (values.runner !== "cloud") {
    const task = getTask(taskId);
    if (task) {
      console.log(JSON.stringify({ ...task, runner: "local" }, null, 2));
      return 0;
    }
    if (values.runner === "local") {
      console.error(`Error: task ${taskId} not found.`);
      return 1;
    }
  }

  const agentId = getAgentId(values.agent);
  if (!agentId) {
    console.error(
      `Error: task ${taskId} not found locally, and --agent or LETTA_AGENT_ID is required to look up Cloud schedules.`,
    );
    return 1;
  }

  try {
    await ensureSettingsForCloud();
    const schedule = await getCloudSchedule(agentId, taskId);
    console.log(JSON.stringify(formatCloudScheduleOutput(schedule), null, 2));
    return 0;
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) {
      console.error(`Error: task ${taskId} not found.`);
    } else {
      console.error(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return 1;
  }
}

async function handleRuns(values: CronArgValues): Promise<number> {
  if (!isRunnerFlagValid(values.runner)) {
    console.error(
      `Error: invalid --runner "${values.runner}". Expected "local" or "cloud".`,
    );
    return 1;
  }

  const id = values.id;
  if (!id || typeof id !== "string") {
    console.error("Error: --id is required. Usage: letta cron runs --id <id>");
    return 1;
  }

  const limitRaw = Number.parseInt(String(values.limit ?? "50"), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
  const runId = values["run-id"];

  // Local run log first (cheap file read) unless --runner cloud.
  if (values.runner !== "cloud" && getTask(id)) {
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

  if (values.runner === "local") {
    console.error(`Error: task ${id} not found.`);
    return 1;
  }

  const agentId = getAgentId(values.agent);
  if (!agentId) {
    console.error(
      `Error: task ${id} not found locally, and --agent or LETTA_AGENT_ID is required to look up Cloud schedule runs.`,
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
  if (!isRunnerFlagValid(values.runner)) {
    console.error(
      `Error: invalid --runner "${values.runner}". Expected "local" or "cloud".`,
    );
    return 1;
  }

  if (values.all) {
    return handleDeleteAll(values);
  }

  const taskId = positionals[1];
  if (!taskId) {
    console.error(
      "Error: task ID required. Usage: letta cron delete <id> or --all --agent <id>",
    );
    return 1;
  }

  if (values.runner !== "cloud") {
    const found = deleteTask(taskId);
    if (found) {
      console.log(JSON.stringify({ deleted: taskId, runner: "local" }));
      return 0;
    }
    if (values.runner === "local") {
      console.error(`Error: task ${taskId} not found.`);
      return 1;
    }
  }

  const agentId = getAgentId(values.agent);
  if (!agentId) {
    console.error(
      `Error: task ${taskId} not found locally, and --agent or LETTA_AGENT_ID is required to delete Cloud schedules.`,
    );
    return 1;
  }

  try {
    await ensureSettingsForCloud();
    // Verify existence first: the cloud delete endpoint is a soft-delete
    // update that reports success even for unknown IDs.
    await getCloudSchedule(agentId, taskId);
    await deleteCloudSchedule(agentId, taskId);
    console.log(JSON.stringify({ deleted: taskId, runner: "cloud" }));
    return 0;
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) {
      console.error(`Error: task ${taskId} not found.`);
    } else {
      console.error(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return 1;
  }
}

async function handleDeleteAll(values: CronArgValues): Promise<number> {
  const agentId = getAgentId(values.agent);
  if (!agentId) {
    console.error("Error: --agent or LETTA_AGENT_ID required with --all.");
    return 1;
  }

  const includeLocal = values.runner !== "cloud";
  const includeCloud = values.runner !== "local";

  let localDeleted = 0;
  if (includeLocal) {
    localDeleted = deleteAllTasks(agentId);
  }

  let cloudDeleted = 0;
  if (includeCloud) {
    const resolved = await getRunnerForAgent(undefined, agentId);
    const cloudCapable = !("error" in resolved) && resolved.runner === "cloud";
    const cloudExplicit = values.runner === "cloud";

    if (cloudCapable || cloudExplicit) {
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
        console.error(
          `Deleted so far: ${localDeleted} local, ${cloudDeleted} cloud.`,
        );
        return 1;
      }
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
      return handleDelete(parsed.values, parsed.positionals);
    default:
      console.error(`Unknown action: ${action}`);
      printUsage();
      return 1;
  }
}
