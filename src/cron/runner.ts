/**
 * Cron runner resolution for `letta cron` (LET-9692).
 *
 * Two runners own scheduled tasks:
 * - "local": the runtime-local scheduler (~/.letta/crons.json), executed by
 *   the WS listener process on this device. Dies with the device/sandbox.
 * - "cloud": durable Cloud schedules (`/v1/agents/:id/schedule`), fired by a
 *   cloud worker into a target listener or the agent's managed Cloud sandbox.
 *
 * Runner ownership follows the execution environment:
 * - Letta-managed Cloud sandboxes use durable Cloud schedules.
 * - User-managed computers and self-hosted runtimes use local schedules.
 *
 * Cloud's owning spawner assigns the listener a `sandbox:` identity. Listener
 * bootstrap derives an inherited runtime marker before consuming that private
 * relay identity. Device registration is not an execution-environment signal:
 * Cloud API-backed laptops are still local computers, and a managed sandbox may
 * have a transient or unregistered listener device id.
 */

import type { EnvironmentConnection } from "@/backend/api/environments";
import { ApiRequestError } from "@/backend/api/request";
import { listCloudSchedules } from "@/backend/api/schedules";
import { resolveBackendMode } from "@/backend/backend-mode";
import { isManagedCloudRuntime } from "@/managed-cloud-runtime";

export type CronRunner = "local" | "cloud";

export const CLOUD_EXECUTION_TARGET = "cloud-sandbox";

export function isManagedCloudSandbox(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isManagedCloudRuntime(env);
}

export interface ResolveCronRunnerParams {
  managedCloudSandbox: boolean;
  /** Active backend mode ("api" | "local"). */
  backendMode: "api" | "local";
  /** Whether the configured server serves the Cloud schedule routes. */
  cloudSchedulesSupported?: boolean;
}

export type ResolveCronRunnerResult =
  | { runner: CronRunner; reason: string }
  | { error: string };

export function resolveCronRunner(
  params: ResolveCronRunnerParams,
): ResolveCronRunnerResult {
  const { managedCloudSandbox, backendMode, cloudSchedulesSupported } = params;

  if (!managedCloudSandbox) {
    return { runner: "local", reason: "local execution environment" };
  }

  if (backendMode === "local") {
    return {
      error:
        "Managed Cloud sandboxes cannot use the local backend for schedules.",
    };
  }

  if (cloudSchedulesSupported === false) {
    return {
      error:
        "Cloud schedules are unavailable in this managed Cloud sandbox. No local schedule was created.",
    };
  }

  return { runner: "cloud", reason: "managed Cloud sandbox" };
}

async function ensureSettingsForCloud(): Promise<void> {
  const { settingsManager } = await import("@/settings-manager");
  await settingsManager.initialize();
}

async function probeCloudScheduleSupport(agentId: string): Promise<boolean> {
  try {
    await listCloudSchedules(agentId, { limit: 1 });
    return true;
  } catch (error) {
    if (
      error instanceof ApiRequestError &&
      (error.status === 404 || error.status === 405)
    ) {
      return false;
    }
    return true;
  }
}

/** Resolve schedule ownership from the current execution environment. */
export async function resolveCronRunnerForAgent(
  agentId: string,
): Promise<ResolveCronRunnerResult> {
  const backendMode = resolveBackendMode();
  const managedCloudSandbox = isManagedCloudSandbox();
  const preliminary = resolveCronRunner({ managedCloudSandbox, backendMode });
  if ("error" in preliminary || preliminary.runner === "local") {
    return preliminary;
  }

  await ensureSettingsForCloud();
  const cloudSchedulesSupported = await probeCloudScheduleSupport(agentId);
  return resolveCronRunner({
    managedCloudSandbox,
    backendMode,
    cloudSchedulesSupported,
  });
}

// ── Target device pre-validation ────────────────────────────────────

/**
 * Synthetic ids the Desktop environment proxy injects into
 * `letta computers list` responses. Neither is a targetable device:
 * - "__letta_cloud__": the synthetic "Cloud" row (the sandbox target)
 * - "local": the synthetic offline placeholder when no local device is registered
 * Values mirror CLOUD_DEVICE_ID / LOCAL_CONNECTION_ID in the desktop app.
 */
const SYNTHETIC_CLOUD_DEVICE_ID = "__letta_cloud__";
const SYNTHETIC_LOCAL_PLACEHOLDER_ID = "local";

export type TargetDeviceValidity = { ok: true } | { ok: false; error: string };

/**
 * Pre-validate a `--computer` value against its resolved environment
 * entry, catching entries that appear in `letta computers list` but are
 * not valid Cloud-schedule targets. In Desktop/local-proxy contexts the list
 * merges desktop-local listener connections (organizationId "local" — they
 * exist only in the local proxy, not the Letta API's environments registry)
 * and a synthetic Cloud row. Targeting either would earn an unhelpful server
 * 404; fail earlier with an actionable message instead.
 *
 * `environment` is null when the device wasn't found locally — that case is
 * allowed through so the server's own registry check stays the backstop
 * (the local list may be unavailable or incomplete).
 */
export function validateTargetDevice(
  deviceId: string,
  environment: { organizationId?: string } | null,
): TargetDeviceValidity {
  if (deviceId === SYNTHETIC_CLOUD_DEVICE_ID) {
    return {
      ok: false,
      error:
        '"Cloud" is not a computer. Omit --computer to run in the agent\'s Cloud sandbox.',
    };
  }

  if (deviceId === SYNTHETIC_LOCAL_PLACEHOLDER_ID) {
    return {
      ok: false,
      error:
        '"local" is a placeholder entry, not a connected computer. Run `letta server` on the machine you want to target, then use its deviceId.',
    };
  }

  if (environment?.organizationId === "local") {
    return {
      ok: false,
      error: `Device ${deviceId} is this computer's local desktop connection, not a computer connected to your Letta account. Cloud schedules can only target connected computers — run \`letta server\` on that machine (or enable remote access in the desktop app) to connect it.`,
    };
  }

  return { ok: true };
}

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

export type CronCreatePlacement =
  | {
      runner: CronRunner;
      targetDeviceId?: string;
    }
  | { error: string };

/**
 * Resolve where a newly-created schedule should live and execute.
 *
 * Both `letta cron` and Wake use this path. Managed Cloud sandboxes always
 * create Cloud schedules; every other execution environment creates local
 * schedules. `--computer` remains a Cloud-only target override.
 */
export async function resolveCronCreatePlacement(params: {
  agentId: string;
  targetDeviceId?: string;
}): Promise<CronCreatePlacement> {
  const resolved = await resolveCronRunnerForAgent(params.agentId);
  if ("error" in resolved) return resolved;

  const targetDeviceId = params.targetDeviceId?.trim() || undefined;
  if (targetDeviceId && resolved.runner !== "cloud") {
    return {
      error:
        "--computer is only available from a managed Cloud sandbox. Run the schedule on this computer instead.",
    };
  }

  if (targetDeviceId) {
    const validity = validateTargetDevice(
      targetDeviceId,
      await lookupEnvironmentForTarget(targetDeviceId),
    );
    if (!validity.ok) return validity;
  }

  return { runner: resolved.runner, targetDeviceId };
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
  /** Optional connected computer to execute on (offline → sandbox fallback). */
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
  "If the target computer is offline when the schedule fires, execution falls back to the agent's cloud sandbox.";

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
