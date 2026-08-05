/**
 * `letta cron` CLI subcommand.
 *
 * Usage:
 *   letta cron add --prompt <text> --every <interval> [--agent <id>] [--conversation <id>] [--runner local|cloud]
 *   letta cron add --prompt <text> --at <time> [--once] [--agent <id>] [--runner local|cloud]
 *   letta cron add --prompt <text> --cron <expr> [--agent <id>] [--runner local|cloud]
 *   letta cron list [--agent <id>] [--conversation <id>] [--runner local|cloud]
 *   letta cron get <id|name> [--runner local|cloud]
 *   letta cron runs --id <id> [--runner local|cloud]
 *   letta cron delete <id|name> [--runner local|cloud]   (alias: remove)
 *   letta cron delete --all [--agent <id>] [--runner local|cloud]
 *
 * Runners (LET-9692):
 * - "cloud" (default for cloud agents): durable Cloud schedules stored by the
 *   Letta API. The implicit default keeps executing where it was created
 *   (external listener target, or untargeted from a managed sandbox);
 *   explicit --runner cloud always executes in the agent's Cloud sandbox.
 *   When the current runtime is unreachable by Cloud scheduling
 *   (desktop-local, unregistered), the implicit default falls back to the
 *   local runner with a warning — that is the only placement that preserves
 *   execution locality there.
 * - "local": runtime-local tasks in ~/.letta/crons.json, executed by the WS
 *   listener on this device. Default for local-backend agents and self-hosted
 *   servers; explicit opt-in (--runner local) for schedules that must run on
 *   this specific machine.
 */

import { parseArgs } from "node:util";
import { getRuntimeEnvironmentDeviceId } from "@/backend/api/client";
import type { EnvironmentConnection } from "@/backend/api/environments";
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
  resolveInferredTargetDevice,
  validateTargetDevice,
} from "./cron-runner";
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
  letta cron get <id|name> [--runner local|cloud]
  letta cron runs --id <id> [--limit <n>] [--runner local|cloud]
  letta cron delete <id|name> [--runner local|cloud]   (alias: remove)
  letta cron delete --all [--agent <id>] [--runner local|cloud]

Add options:
  --prompt <text>        Prompt to send to the agent (required)
  --every <interval>     Recurring interval (e.g. 5m, 2h, 1d)
  --at <time>            Scheduled time (e.g. "3:00pm", "in 45m")
  --once                 Fire once (with --at); default for --at
  --cron <expr>          Raw 5-field cron expression
  --agent <id>           Agent ID (defaults to LETTA_AGENT_ID)
  --conversation <id>    Conversation ID (defaults to LETTA_CONVERSATION_ID or "default")
  --runner <runner>      Where the schedule lives and fires (normally omit:
                         the default keeps the schedule running where it was
                         created):
                           cloud - durable Cloud schedule (default for cloud
                                   agents on Cloud-reachable runtimes:
                                   external listeners are targeted, managed
                                   sandboxes stay untargeted). Explicit
                                   --runner cloud always uses the Cloud sandbox
                           local - this device's scheduler (~/.letta/crons.json);
                                   only fires while a session runs here (default
                                   for local-backend agents / self-hosted, and
                                   the fallback when Cloud scheduling cannot
                                   reach this computer)
  --computer <id>        (cloud runner only) Override execution with a
                         connected external environment (deviceId from
                         \`letta environments list\`). Falls back to the Cloud
                         sandbox if the computer is offline at fire time.
                         Managed sandboxes and Desktop-local connections are
                         not currently valid Cloud schedule targets.

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

/**
 * Best-effort lookup of a --computer deviceId in the environments registry
 * (through the same base URL the schedule request will use, so Desktop's
 * merged local+cloud view is what gets validated). Returns null when the
 * lookup fails or the device is unknown — the server-side registry check on
 * schedule create remains the backstop for those cases.
 */
async function lookupEnvironmentForTarget(
  deviceId: string,
): Promise<EnvironmentConnection | null> {
  try {
    const { getEnvironmentConnection } = await import(
      "@/backend/api/environments"
    );
    return await getEnvironmentConnection(deviceId);
  } catch {
    return null;
  }
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

  let targetDeviceId = values.computer?.trim() || undefined;

  const resolved = await getRunnerForAgent(values.runner, agentId);
  if ("error" in resolved) {
    console.error(`Error: ${resolved.error}`);
    return 1;
  }
  let runner = resolved.runner;
  let localFallbackNote: string | undefined;

  // Device targets are a Cloud-schedule feature: the cloud worker delivers
  // to the named device's listener (sandbox fallback when offline). A local
  // task already runs on the device that owns it, so the flag is meaningless
  // (and likely a mistake) for the local runner.
  if (targetDeviceId && runner !== "cloud") {
    console.error(
      "Error: --computer requires the cloud runner. Run `letta cron add` on the target computer itself (with --runner local) to schedule there locally.",
    );
    return 1;
  }

  // Pre-validate explicit targets against entries that are visible through a
  // Desktop proxy but cannot be addressed by the Cloud environments registry.
  if (targetDeviceId) {
    const validity = validateTargetDevice(
      targetDeviceId,
      await lookupEnvironmentForTarget(targetDeviceId),
    );
    if (!validity.ok) {
      console.error(`Error: ${validity.error}`);
      return 1;
    }
  } else if (runner === "cloud" && values.runner !== "cloud") {
    // The durable default preserves the locality of the current agent turn.
    // Infer only at create time: old targetless schedules deliberately remain
    // Cloud-sandbox schedules, and dispatch must never guess a target later.
    // Managed-sandbox runtimes resolve to an untargeted schedule (the
    // sandbox IS the untargeted execution environment). Runtimes the Cloud
    // scheduler cannot reach (desktop-local, unregistered) fall back to the
    // local runner so the schedule still executes here.
    const inferredDeviceId = getRuntimeEnvironmentDeviceId();
    const resolution = await resolveInferredTargetDevice(inferredDeviceId, () =>
      lookupEnvironmentForTarget(inferredDeviceId),
    );
    if (resolution.kind === "device") {
      targetDeviceId = inferredDeviceId;
    } else if (resolution.kind === "local-fallback") {
      runner = "local";
      localFallbackNote = `This schedule is local to this computer (${resolution.reason}): it only fires while a Letta session is running here. For a schedule that fires regardless, pass --runner cloud (runs in the agent's cloud sandbox) or --computer <deviceId> (runs on a connected computer, from \`letta environments list\`).`;
    }
  }

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
    // Recurring jobs pinned to an unregistered computer are usually a
    // mistake (the user expects "every Monday" to survive this session);
    // one-shot follow-ups usually aren't (a dead session obviates them).
    const fallbackWarning =
      localFallbackNote && recurring
        ? `${localFallbackNote} Recurring schedules on an unregistered computer stop firing whenever no session is running — strongly consider a durable alternative.`
        : localFallbackNote;
    const warnings = [fallbackWarning, result.warning].filter(Boolean);
    if (warnings.length > 0) {
      output.warning = warnings.join(" ");
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
    const result = await createCloudSchedule(params.agentId, built.input);

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
    const cloudExplicit = values.runner === "cloud";

    // No capability pre-probe here: the probe maps any 404/405 to "server
    // doesn't serve Cloud schedules" and would skip this section silently,
    // hiding real Cloud schedules behind e.g. a transient auth/visibility
    // 404 (LET-10492). Listing is read-only, so just attempt it — cheap
    // local-only cases (local-backend agents) still resolve without a
    // network call, and every failure is surfaced as a warning.
    const backendMode = resolveBackendMode();
    const preliminary = resolveCronRunner({ agentId, backendMode });
    const cloudCandidate =
      !("error" in preliminary) && preliminary.runner === "cloud";

    if (cloudCandidate || cloudExplicit) {
      try {
        await ensureSettingsForCloud();
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
        // Never skip silently (LET-10492) — but calibrate the tone: a 404/405
        // usually means the server doesn't serve the schedule routes at all
        // (self-hosted OSS core), which is an expected steady state, not a
        // failure. It can also mean the agent isn't visible to the current
        // credential, so name both.
        if (
          err instanceof ApiRequestError &&
          (err.status === 404 || err.status === 405)
        ) {
          console.error(
            "Note: Cloud schedules not listed (server does not serve the schedule routes, or this agent is not visible to the current credential).",
          );
        } else {
          console.error(
            `Warning: Cloud schedules not listed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
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

  const taskRef = positionals[1];
  if (!taskRef) {
    console.error(
      "Error: task ID or name required. Usage: letta cron get <id|name>",
    );
    return 1;
  }

  const agentId = getAgentId(values.agent);

  // Local store is a cheap file read; check it first unless --runner cloud.
  if (values.runner !== "cloud") {
    const task = getTask(taskRef);
    if (task) {
      console.log(JSON.stringify({ ...task, runner: "local" }, null, 2));
      return 0;
    }
  }

  // Cloud lookup by ID (unless --runner local).
  if (values.runner !== "local" && agentId) {
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
      // 404 → not an ID; fall through to name resolution.
    }
  }

  if (values.runner !== "local" && !agentId) {
    console.error(
      `Error: task ${taskRef} not found locally, and --agent or LETTA_AGENT_ID is required to look up Cloud schedules.`,
    );
    return 1;
  }

  // Not an ID in either store — try it as a task name (LET-10492).
  const resolved = await resolveTaskName(taskRef, {
    runner: values.runner,
    agentId,
  });
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

  const taskRef = positionals[1];
  if (!taskRef) {
    console.error(
      "Error: task ID or name required. Usage: letta cron delete <id|name> or --all --agent <id>",
    );
    return 1;
  }

  if (values.runner !== "cloud") {
    const found = deleteTask(taskRef);
    if (found) {
      console.log(JSON.stringify({ deleted: taskRef, runner: "local" }));
      return 0;
    }
  }

  const agentId = getAgentId(values.agent);

  // Cloud delete by ID (unless --runner local).
  if (values.runner !== "local") {
    if (!agentId) {
      console.error(
        `Error: task ${taskRef} not found locally, and --agent or LETTA_AGENT_ID is required to delete Cloud schedules.`,
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
  const resolved = await resolveTaskName(taskRef, {
    runner: values.runner,
    agentId,
  });
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
