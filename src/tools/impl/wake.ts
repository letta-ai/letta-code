import { CronExpressionParser } from "cron-parser";
import { ApiRequestError } from "@/backend/api/request";
import {
  type CloudSchedule,
  createCloudSchedule,
  deleteCloudSchedule,
  listCloudSchedules,
} from "@/backend/api/schedules";
import { resolveBackendMode } from "@/backend/backend-mode";
import {
  type AddTaskInput,
  addTask,
  type CronTask,
  deleteTask,
  isValidCron,
  listTasks,
  parseRfc3339Timestamp,
} from "@/cron";
import {
  buildCloudScheduleInput,
  CLOUD_EXECUTION_TARGET,
  resolveCronCreatePlacement,
} from "@/cron/runner";
import {
  getRuntimeActingUserAssertion,
  getRuntimeActingUserId,
  getRuntimeContext,
} from "@/runtime-context";

type WakeAction = "create" | "list" | "cancel";

interface WakeArgs {
  action: WakeAction;
  name?: string;
  prompt?: string;
  after_seconds?: number;
  scheduled_at?: string;
  cron?: string;
  id?: string;
  signal?: AbortSignal;
}

interface WakeScope {
  agentId: string;
  conversationId: string;
}

interface WakeRecord {
  id: string;
  runner: "local" | "cloud";
  name: string | null;
  prompt: string | null;
  recurring: boolean;
  scheduled_at: string | null;
  cron: string | null;
  status: string;
}

interface WakeDeps {
  now?: () => Date;
  resolvePlacement?: typeof resolveCronCreatePlacement;
  createCloud?: typeof createCloudSchedule;
  listCloud?: typeof listCloudSchedules;
  deleteCloud?: typeof deleteCloudSchedule;
  addLocal?: typeof addTask;
  listLocal?: typeof listTasks;
  deleteLocal?: typeof deleteTask;
}

interface WakeResult {
  content: string;
  status: "success" | "error";
}

const MAX_ACTIVE_WAKES = 20;
const MIN_RECURRING_INTERVAL_MS = 60 * 60 * 1000;
const MAX_NAME_LENGTH = 80;
const MAX_PROMPT_LENGTH = 4000;

function result(
  status: WakeResult["status"],
  payload: Record<string, unknown>,
): WakeResult {
  return { content: JSON.stringify(payload, null, 2), status };
}

function requireScope(): WakeScope {
  const context = getRuntimeContext();
  const agentId = context?.agentId?.trim();
  const conversationId = context?.conversationId?.trim();
  if (!agentId || !conversationId) {
    throw new Error("Wake requires the current agent and conversation.");
  }
  return { agentId, conversationId };
}

function oneShotCron(date: Date): string {
  return `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`;
}

function minimumCronIntervalMs(cron: string, now: Date): number {
  const expression = CronExpressionParser.parse(cron, {
    currentDate: now,
    tz: "UTC",
  });
  let previous = expression.next().toDate();
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 32; index += 1) {
    const next = expression.next().toDate();
    minimum = Math.min(minimum, next.getTime() - previous.getTime());
    previous = next;
  }
  return minimum;
}

function parseCreateTiming(
  args: WakeArgs,
  now: Date,
): {
  cron: string;
  recurring: boolean;
  scheduledFor?: Date;
} {
  const supplied = [
    args.after_seconds !== undefined,
    args.scheduled_at !== undefined,
    args.cron !== undefined,
  ].filter(Boolean).length;
  if (supplied !== 1) {
    throw new Error(
      "Wake create requires exactly one of after_seconds, scheduled_at, or cron.",
    );
  }

  if (args.after_seconds !== undefined) {
    if (
      !Number.isInteger(args.after_seconds) ||
      args.after_seconds < 60 ||
      args.after_seconds > 31_536_000
    ) {
      throw new Error(
        "Wake after_seconds must be an integer between 60 and 31536000.",
      );
    }
    const scheduledFor = new Date(now.getTime() + args.after_seconds * 1000);
    return {
      cron: oneShotCron(scheduledFor),
      recurring: false,
      scheduledFor,
    };
  }

  if (args.scheduled_at !== undefined) {
    const value = args.scheduled_at.trim();
    const scheduledFor = parseRfc3339Timestamp(value);
    if (!scheduledFor) {
      throw new Error(
        "Wake scheduled_at must be RFC 3339 with Z or an explicit UTC offset.",
      );
    }
    if (scheduledFor.getTime() <= now.getTime()) {
      throw new Error("Wake scheduled_at must be a valid future time.");
    }
    return {
      cron: oneShotCron(scheduledFor),
      recurring: false,
      scheduledFor,
    };
  }

  const cron = args.cron?.trim() ?? "";
  if (!isValidCron(cron)) {
    throw new Error("Wake cron must be a valid five-field cron expression.");
  }
  if (minimumCronIntervalMs(cron, now) < MIN_RECURRING_INTERVAL_MS) {
    throw new Error("Wake cron cannot run more often than hourly.");
  }
  return { cron, recurring: true };
}

function promptFromCloudSchedule(schedule: CloudSchedule): string | null {
  const first = schedule.message.messages?.[0];
  return first && typeof first.content === "string" ? first.content : null;
}

function localWakeRecord(task: CronTask): WakeRecord {
  return {
    id: task.id,
    runner: "local",
    name: task.name,
    prompt: task.prompt,
    recurring: task.recurring,
    scheduled_at: task.scheduled_for,
    cron: task.recurring ? task.cron : null,
    status: task.status,
  };
}

function cloudWakeRecord(schedule: CloudSchedule): WakeRecord {
  return {
    id: schedule.id,
    runner: "cloud",
    name: schedule.name ?? null,
    prompt: promptFromCloudSchedule(schedule),
    recurring: schedule.schedule.type === "recurring",
    scheduled_at: schedule.next_scheduled_time,
    cron:
      schedule.schedule.type === "recurring"
        ? schedule.schedule.cron_expression
        : null,
    status: "active",
  };
}

async function listCurrentWakes(
  scope: WakeScope,
  args: WakeArgs,
  deps: WakeDeps,
): Promise<{ wakes: WakeRecord[]; warnings: string[] }> {
  const localTasks = (deps.listLocal ?? listTasks)({
    agent_id: scope.agentId,
    conversation_id: scope.conversationId,
  });
  const wakes = localTasks
    .filter((task) => task.status === "active" || task.status === "paused")
    .map(localWakeRecord);
  const warnings: string[] = [];

  if (
    resolveBackendMode() === "local" ||
    scope.agentId.startsWith("agent-local-")
  ) {
    return { wakes, warnings };
  }

  try {
    let after: string | undefined;
    do {
      args.signal?.throwIfAborted();
      const page = await (deps.listCloud ?? listCloudSchedules)(scope.agentId, {
        limit: 100,
        after,
      });
      const matching = page.scheduled_messages.filter(
        (schedule) => schedule.conversation_id === scope.conversationId,
      );
      wakes.push(...matching.map(cloudWakeRecord));
      after = page.has_next_page
        ? page.scheduled_messages.at(-1)?.id
        : undefined;
    } while (after);
  } catch (error) {
    if (
      error instanceof ApiRequestError &&
      (error.status === 404 || error.status === 405)
    ) {
      return { wakes, warnings };
    }
    warnings.push(
      `Cloud wakes could not be listed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { wakes, warnings };
}

function requireCreateText(args: WakeArgs): { name: string; prompt: string } {
  const name = args.name?.trim() ?? "";
  const prompt = args.prompt?.trim() ?? "";
  if (!name) throw new Error("Wake create requires name.");
  if (!prompt) throw new Error("Wake create requires prompt.");
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`Wake name must be at most ${MAX_NAME_LENGTH} characters.`);
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(
      `Wake prompt must be at most ${MAX_PROMPT_LENGTH} characters.`,
    );
  }
  return { name, prompt };
}

async function createWake(
  args: WakeArgs,
  scope: WakeScope,
  deps: WakeDeps,
): Promise<WakeResult> {
  const { name, prompt } = requireCreateText(args);
  const now = (deps.now ?? (() => new Date()))();
  const timing = parseCreateTiming(args, now);
  args.signal?.throwIfAborted();
  const placement = await (deps.resolvePlacement ?? resolveCronCreatePlacement)(
    { agentId: scope.agentId },
  );
  if ("error" in placement) throw new Error(placement.error);

  const current = await listCurrentWakes(scope, args, deps);
  if (placement.runner === "cloud" && current.warnings.length > 0) {
    throw new Error(current.warnings[0]);
  }
  const activeWakeCount = current.wakes.filter(
    (wake) => wake.status === "active",
  ).length;
  if (activeWakeCount >= MAX_ACTIVE_WAKES) {
    throw new Error(
      `This conversation already has ${activeWakeCount} active wakes (max ${MAX_ACTIVE_WAKES}). Cancel one before creating another.`,
    );
  }

  const description = `Self-scheduled wake: ${name}`;
  if (placement.runner === "cloud") {
    const built = buildCloudScheduleInput({
      name,
      description,
      prompt,
      conversationId: scope.conversationId,
      cron: timing.cron,
      recurring: timing.recurring,
      scheduledFor: timing.scheduledFor,
      targetDeviceId: placement.targetDeviceId,
    });
    const created = await (deps.createCloud ?? createCloudSchedule)(
      scope.agentId,
      built.input,
      getRuntimeActingUserId(),
      getRuntimeActingUserAssertion(),
    );
    const targetDeviceId =
      created.target_device_id ?? built.input.target_device_id ?? null;
    return result("success", {
      action: "created",
      id: created.id,
      name,
      runner: "cloud",
      execution_target: targetDeviceId ?? CLOUD_EXECUTION_TARGET,
      conversation_id: scope.conversationId,
      recurring: timing.recurring,
      ...(created.next_scheduled_at && {
        next_scheduled_at: created.next_scheduled_at,
      }),
      notes: [...current.warnings, ...built.notes],
    });
  }

  const input: AddTaskInput = {
    agent_id: scope.agentId,
    conversation_id: scope.conversationId,
    name,
    description,
    cron: timing.cron,
    timezone: "UTC",
    recurring: timing.recurring,
    prompt,
    scheduled_for: timing.scheduledFor,
  };
  const created = (deps.addLocal ?? addTask)(input);
  const warnings = [
    ...current.warnings,
    placement.localFallbackNote,
    created.warning,
  ].filter((warning): warning is string => Boolean(warning));
  return result("success", {
    action: "created",
    id: created.task.id,
    name,
    runner: "local",
    conversation_id: scope.conversationId,
    recurring: timing.recurring,
    scheduled_at: created.task.scheduled_for,
    warnings,
  });
}

async function cancelWake(
  args: WakeArgs,
  scope: WakeScope,
  deps: WakeDeps,
): Promise<WakeResult> {
  const id = args.id?.trim();
  if (!id) throw new Error("Wake cancel requires id.");
  const current = await listCurrentWakes(scope, args, deps);
  const wake = current.wakes.find((candidate) => candidate.id === id);
  if (!wake) {
    if (current.warnings.length > 0) {
      throw new Error(current.warnings[0]);
    }
    throw new Error(`Wake ${id} was not found in the current conversation.`);
  }

  args.signal?.throwIfAborted();
  if (wake.runner === "cloud") {
    await (deps.deleteCloud ?? deleteCloudSchedule)(scope.agentId, id);
  } else if (!(deps.deleteLocal ?? deleteTask)(id)) {
    throw new Error(`Wake ${id} was already removed.`);
  }
  return result("success", {
    action: "cancelled",
    id,
    runner: wake.runner,
    warnings: current.warnings,
  });
}

export async function wake(
  args: WakeArgs,
  deps: WakeDeps = {},
): Promise<WakeResult> {
  try {
    args.signal?.throwIfAborted();
    const scope = requireScope();
    switch (args.action) {
      case "create":
        return await createWake(args, scope, deps);
      case "list": {
        const current = await listCurrentWakes(scope, args, deps);
        return result("success", {
          action: "listed",
          conversation_id: scope.conversationId,
          wakes: current.wakes,
          warnings: current.warnings,
        });
      }
      case "cancel":
        return await cancelWake(args, scope, deps);
      default:
        throw new Error("Wake action must be create, list, or cancel.");
    }
  } catch (error) {
    return result("error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
