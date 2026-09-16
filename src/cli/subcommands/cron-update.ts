import { ApiRequestError } from "@/backend/api/request";
import {
  getCloudSchedule,
  type UpdateCloudScheduleInput,
  updateCloudSchedule,
} from "@/backend/api/schedules";
import { resolveBackendMode } from "@/backend/backend-mode";
import {
  computeJitter,
  getTask,
  isValidCron,
  parseAt,
  parseEvery,
  updateTask,
} from "@/cron";
import { formatCloudScheduleOutput } from "./cron-output";
import {
  CLOUD_CRON_UTC_NOTE,
  resolveCronRunner,
  validateTargetDevice,
} from "./cron-runner";
import {
  resolveCronAddConversationTarget,
  resolveCronAgentId,
} from "./cron-scope";
import {
  ensureSettingsForCloud,
  printAmbiguousTaskName,
  type ResolvedTaskRef,
  resolveTaskName,
} from "./cron-task-ref";

interface CronUpdateOptions {
  name?: string;
  description?: string;
  prompt?: string;
  every?: string;
  at?: string;
  cron?: string;
  once?: boolean;
  conversation?: string;
  computer?: string;
  agent?: string;
  runner?: string;
}

/** Parse edits without filling in creation defaults or consulting the network. */
export function buildCronUpdate(values: CronUpdateOptions): {
  cloud: UpdateCloudScheduleInput;
  localSchedule?: {
    cron: string;
    recurring: boolean;
    scheduled_for: string | null;
  };
  note?: string;
} {
  if (
    values.runner !== undefined &&
    !["local", "cloud"].includes(values.runner)
  ) {
    throw new Error('Invalid --runner. Expected "local" or "cloud".');
  }
  const cloud: UpdateCloudScheduleInput = {};
  for (const field of ["name", "description"] as const) {
    if (values[field] !== undefined) cloud[field] = values[field];
  }
  if (values.prompt !== undefined) {
    if (!values.prompt.trim()) throw new Error("--prompt must not be empty.");
    cloud.messages = [{ role: "user", content: values.prompt }];
  }
  if (values.conversation !== undefined) {
    if (!values.conversation.trim())
      throw new Error("--conversation must not be empty.");
    const target = resolveCronAddConversationTarget(values.conversation);
    if (target === null) throw new Error("Unable to resolve --conversation.");
    cloud.conversation_id = target;
  }
  if (values.computer !== undefined) {
    const target = values.computer.trim();
    if (!target)
      throw new Error(
        "--computer must not be empty; use cloud to clear the target.",
      );
    if (values.runner === "local")
      throw new Error("--computer requires the cloud runner.");
    cloud.target_device_id = target === "cloud" ? null : target;
  }

  const specs = [values.every, values.at, values.cron].filter(
    (v) => v !== undefined,
  );
  if (specs.length > 1)
    throw new Error("Only one of --every, --at, or --cron allowed.");
  if (values.once && values.at === undefined)
    throw new Error("--once requires --at.");
  let localSchedule: ReturnType<typeof buildCronUpdate>["localSchedule"];
  let note: string | undefined;
  if (values.every !== undefined) {
    const parsed = parseEvery(values.every);
    if (!parsed)
      throw new Error(`Invalid interval "${values.every}". Try: 5m, 2h, 1d`);
    localSchedule = { cron: parsed.cron, recurring: true, scheduled_for: null };
    note = parsed.note;
  } else if (values.at !== undefined) {
    const parsed = parseAt(values.at);
    if (!parsed)
      throw new Error(`Invalid time "${values.at}". Try: "3:00pm", "in 45m"`);
    localSchedule = {
      cron: parsed.cron,
      recurring: false,
      scheduled_for: parsed.scheduledFor.toISOString(),
    };
    cloud.schedule = {
      type: "one-time",
      scheduled_at: parsed.scheduledFor.getTime(),
    };
    note = parsed.note;
  } else if (values.cron !== undefined) {
    if (!isValidCron(values.cron))
      throw new Error(
        `Invalid cron expression "${values.cron}". Needs 5 fields.`,
      );
    localSchedule = { cron: values.cron, recurring: true, scheduled_for: null };
  }
  if (localSchedule?.recurring) {
    cloud.schedule = { type: "recurring", cron_expression: localSchedule.cron };
  }
  if (Object.keys(cloud).length === 0)
    throw new Error("Supply at least one field to update.");
  return { cloud, localSchedule, note };
}

async function resolveUpdateTask(
  ref: string,
  values: CronUpdateOptions,
  agentId: string,
): Promise<ResolvedTaskRef | null> {
  if (values.runner !== "cloud" && getTask(ref))
    return { id: ref, store: "local" };
  const preliminary = resolveCronRunner({
    agentId,
    backendMode: resolveBackendMode(),
  });
  const includeCloud =
    values.runner === "cloud" ||
    (values.runner !== "local" &&
      !("error" in preliminary) &&
      preliminary.runner === "cloud");
  if (includeCloud && agentId) {
    await ensureSettingsForCloud();
    try {
      await getCloudSchedule(agentId, ref);
      return { id: ref, store: "cloud" };
    } catch (error) {
      if (!(error instanceof ApiRequestError && error.status === 404))
        throw error;
    }
  }
  const resolved = await resolveTaskName(ref, {
    runner: values.runner,
    agentId,
  });
  if (resolved && "ambiguous" in resolved) {
    printAmbiguousTaskName(ref, resolved.ambiguous);
    return null;
  }
  if (!resolved) {
    throw new Error(
      `Task ${ref} not found.${!agentId && values.runner !== "local" ? " --agent or LETTA_AGENT_ID is required to look up Cloud schedules." : ""}`,
    );
  }
  return resolved;
}

export async function handleCronUpdate(
  values: CronUpdateOptions,
  positionals: string[],
): Promise<number> {
  try {
    const ref = positionals[1];
    if (!ref || positionals.length !== 2)
      throw new Error("Usage: letta cron update <id|name> [options]");
    // Reject unrelated flags rather than silently accepting an apparent edit.
    const allowed = new Set([
      "name",
      "description",
      "prompt",
      "every",
      "at",
      "cron",
      "once",
      "conversation",
      "computer",
      "agent",
      "runner",
    ]);
    for (const key of Object.keys(values)) {
      if (!allowed.has(key))
        throw new Error(`--${key} is not an update option.`);
    }
    const edits = buildCronUpdate(values);
    const agentId = resolveCronAgentId(values.agent);
    const resolved = await resolveUpdateTask(ref, values, agentId);
    if (!resolved) return 1;
    if (resolved.store === "local") {
      if (values.computer !== undefined)
        throw new Error("--computer requires the cloud runner.");
      const task = updateTask(resolved.id, (task) => {
        if (agentId && task.agent_id !== agentId)
          throw new Error("Task belongs to a different agent.");
        if (values.name !== undefined) task.name = values.name;
        if (values.description !== undefined)
          task.description = values.description;
        if (values.prompt !== undefined) task.prompt = values.prompt;
        if (edits.cloud.conversation_id !== undefined)
          task.conversation_id = edits.cloud.conversation_id ?? "default";
        if (edits.localSchedule) {
          Object.assign(task, edits.localSchedule);
          task.jitter_offset_ms = computeJitter(
            task.id,
            task.cron,
            task.recurring,
            task.scheduled_for ? new Date(task.scheduled_for) : null,
            new Date(task.created_at),
          );
          // Explicit rescheduling rearms completed one-shots, but never unpauses.
          if (task.status !== "paused") {
            task.status = "active";
            task.cancel_reason = null;
          }
        }
      });
      if (!task) throw new Error(`Task ${resolved.id} not found.`);
      console.log(JSON.stringify({ ...task, runner: "local" }, null, 2));
    } else {
      if (edits.cloud.target_device_id) {
        const { getEnvironmentConnection } = await import(
          "@/backend/api/environments"
        );
        const target = edits.cloud.target_device_id;
        const environment = await getEnvironmentConnection(target).catch(
          () => null,
        );
        const validity = validateTargetDevice(target, environment);
        if (!validity.ok) throw new Error(validity.error);
      }
      await updateCloudSchedule(agentId, resolved.id, edits.cloud);
      if (edits.cloud.schedule?.type === "recurring") {
        console.error(`Note: ${CLOUD_CRON_UTC_NOTE}`);
      }
      try {
        const updated = await getCloudSchedule(agentId, resolved.id);
        console.log(
          JSON.stringify(formatCloudScheduleOutput(updated), null, 2),
        );
      } catch (error) {
        throw new Error(
          `Schedule ${resolved.id} was updated, but reading the result failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (edits.note) console.error(`Note: ${edits.note}`);
    return 0;
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
