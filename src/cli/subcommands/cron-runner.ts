/**
 * Cron runner resolution for `letta cron` (LET-9692).
 *
 * Two runners own scheduled tasks:
 * - "local": the runtime-local scheduler (~/.letta/crons.json), executed by
 *   the WS listener process on this device. Dies with the device/sandbox.
 * - "cloud": durable Cloud schedules (`/v1/agents/:id/schedule`), fired by a
 *   cloud worker into the agent's managed cloud sandbox.
 *
 * Default policy: cloud agents get the cloud runner everywhere (laptop, VPS,
 * managed sandbox) — durability is the default. `--runner local` is the
 * explicit opt-in for schedules that must execute on a specific machine
 * (e.g. they need that device's filesystem). Local-backend agents
 * (`agent-local-*`) always use the local runner, and servers that don't serve
 * the Cloud schedule routes (self-hosted OSS core) fall back to it.
 *
 * Cloud support is determined by probing the schedule route, not by
 * inspecting the base URL: managed sandboxes and Desktop sessions point
 * LETTA_BASE_URL at a localhost proxy that forwards to the Letta API, so URL
 * shape says nothing about capability.
 */

export type CronRunner = "local" | "cloud";

export const CLOUD_EXECUTION_TARGET = "cloud-sandbox";

export interface ResolveCronRunnerParams {
  /** Explicit `--runner` flag value, if provided. */
  explicit?: string;
  agentId: string;
  /** Active backend mode ("api" | "local"). */
  backendMode: "api" | "local";
  /**
   * Whether the configured server serves the Cloud schedule routes, when
   * known (from probing `GET /v1/agents/:id/schedule`). Omit for the
   * pre-probe pass: cloud-eligible agents then resolve to "cloud" as a
   * candidate, and the caller re-resolves once support is known.
   */
  cloudSchedulesSupported?: boolean;
}

export type ResolveCronRunnerResult =
  | { runner: CronRunner; reason: string }
  | { error: string };

function isLocalAgent(agentId: string): boolean {
  return agentId.startsWith("agent-local-");
}

export function resolveCronRunner(
  params: ResolveCronRunnerParams,
): ResolveCronRunnerResult {
  const { explicit, agentId, backendMode, cloudSchedulesSupported } = params;

  if (explicit !== undefined && explicit !== "local" && explicit !== "cloud") {
    return {
      error: `invalid --runner "${explicit}". Expected "local" or "cloud".`,
    };
  }

  if (explicit === "local") {
    return { runner: "local", reason: "explicit --runner local" };
  }

  if (backendMode === "local" || isLocalAgent(agentId)) {
    if (explicit === "cloud") {
      return {
        error:
          "Cloud schedules are not available for local-backend agents. Use --runner local.",
      };
    }
    return { runner: "local", reason: "local-backend agent" };
  }

  if (cloudSchedulesSupported === false) {
    if (explicit === "cloud") {
      return {
        error:
          "This Letta server does not serve Cloud schedule routes (self-hosted?). Use --runner local.",
      };
    }
    return {
      runner: "local",
      reason: "server does not support Cloud schedules",
    };
  }

  return {
    runner: "cloud",
    reason:
      explicit === "cloud"
        ? "explicit --runner cloud"
        : "cloud agent defaults to durable Cloud schedules",
  };
}

// ── Cloud payload mapping ───────────────────────────────────────────

export interface BuildCloudScheduleParams {
  name: string;
  description: string;
  prompt: string;
  conversationId: string;
  cron: string;
  recurring: boolean;
  scheduledFor?: Date;
  /** Optional registered device to execute on (offline → sandbox fallback). */
  targetDeviceId?: string;
}

export interface BuiltCloudSchedule {
  input: {
    name: string;
    description: string;
    conversation_id?: string;
    messages: Array<{ role: string; content: string }>;
    schedule:
      | { type: "recurring"; cron_expression: string }
      | { type: "one-time"; scheduled_at: number };
    target_device_id?: string;
  };
  /** Caveats to surface in CLI output. */
  notes: string[];
}

/**
 * Recurring Cloud schedules currently parse bare cron expressions in the
 * cloud worker's timezone (UTC) — the contract has no IANA timezone field
 * yet (LET-9815). Surface that so agents/users aren't surprised.
 */
export const CLOUD_CRON_UTC_NOTE =
  "Recurring Cloud schedules currently interpret cron expressions in UTC (timezone support is tracked in LET-9815).";

export const CLOUD_DEVICE_FALLBACK_NOTE =
  "If the target device is offline when the schedule fires, execution falls back to the agent's cloud sandbox.";

export function buildCloudScheduleInput(
  params: BuildCloudScheduleParams,
): BuiltCloudSchedule {
  const notes: string[] = [];

  let schedule: BuiltCloudSchedule["input"]["schedule"];
  if (params.recurring) {
    schedule = { type: "recurring", cron_expression: params.cron };
    notes.push(CLOUD_CRON_UTC_NOTE);
  } else {
    const scheduledAt = params.scheduledFor?.getTime();
    if (!scheduledAt || Number.isNaN(scheduledAt)) {
      throw new Error("One-shot Cloud schedules require a resolved --at time.");
    }
    schedule = { type: "one-time", scheduled_at: scheduledAt };
  }

  const targetDeviceId = params.targetDeviceId?.trim();
  if (targetDeviceId) {
    notes.push(CLOUD_DEVICE_FALLBACK_NOTE);
  }

  return {
    input: {
      name: params.name,
      description: params.description,
      ...(params.conversationId && { conversation_id: params.conversationId }),
      messages: [{ role: "user", content: params.prompt }],
      schedule,
      ...(targetDeviceId && { target_device_id: targetDeviceId }),
    },
    notes,
  };
}
