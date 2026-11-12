/**
 * Cron runner resolution for `letta cron` (LET-9692).
 *
 * Two runners own scheduled tasks:
 * - "local": the runtime-local scheduler (~/.letta/crons.json), executed by
 *   the WS listener process on this device. Dies with the device/sandbox.
 * - "cloud": durable Cloud schedules (`/v1/agents/:id/schedule`), fired by a
 *   cloud worker into a target listener or the agent's managed Cloud sandbox.
 *
 * Cloud runtimes use durable schedules. Only interactive TUI and Desktop
 * sessions, local backends, and servers without schedule routes use local crons.
 */

import { isLocalAgentId } from "@/agent/agent-id";
import type { EnvironmentConnection } from "@/backend/api/environments";
import { ApiRequestError } from "@/backend/api/request";
import { listCloudSchedules } from "@/backend/api/schedules";
import { isCloudServerUrl } from "@/backend/api/server-url";
import { resolveBackendMode } from "@/backend/backend-mode";
import { isManagedCloudRuntime } from "@/managed-cloud-runtime";
import { getRuntimeContext, getRuntimeSessionSource } from "@/runtime-context";

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
  listenerDeviceId?: string;
  localSchedulesAllowed?: boolean;
  cloudServer?: boolean;
}

export type ResolveCronRunnerResult =
  | { runner: CronRunner; reason: string; targetDeviceId?: string }
  | { error: string };

export function resolveCronRunner(
  params: ResolveCronRunnerParams,
): ResolveCronRunnerResult {
  const { managedCloudSandbox, backendMode, cloudSchedulesSupported } = params;

  if (managedCloudSandbox) {
    if (backendMode === "local") {
      return {
        error: "Scheduling requires the API backend. Configure it, then retry.",
      };
    }
    if (cloudSchedulesSupported === false) {
      return {
        error:
          "Scheduling is unavailable. Check the server connection, then retry.",
      };
    }
    return { runner: "cloud", reason: "managed Cloud sandbox" };
  }
  if (backendMode === "local" || params.localSchedulesAllowed) {
    return { runner: "local", reason: "local execution environment" };
  }
  if (cloudSchedulesSupported === false) {
    return params.cloudServer === false
      ? { runner: "local", reason: "server has no schedule routes" }
      : {
          error:
            "Scheduling is unavailable. Check the server connection, then retry.",
        };
  }
  if (params.listenerDeviceId) {
    return {
      runner: "cloud",
      reason: "registered listener",
      targetDeviceId: params.listenerDeviceId,
    };
  }
  return {
    error: "Register this computer with `letta server`, then retry.",
  };
}

/** Local execution is reserved for interactive and Desktop-owned sessions. */
function allowsLocalCloudSchedules(): boolean {
  return (
    process.env.LETTA_DESKTOP_MODE === "1" ||
    getRuntimeSessionSource() === "interactive-cli"
  );
}

/** Guard the legacy local scheduler and protocol mutations without altering inventory. */
export function getLocalCronExecutionError(action = "run"): string | undefined {
  if (isManagedCloudSandbox()) {
    return `This schedule cannot ${action === "run" ? "run" : `be ${action}`} here. Create a replacement with Wake or letta cron.`;
  }
  if (
    resolveBackendMode() === "api" &&
    isCloudServerUrl() &&
    !allowsLocalCloudSchedules()
  ) {
    return `This schedule cannot ${action === "run" ? "run" : `be ${action}`} here. Create a replacement with Wake or letta cron.`;
  }
  return undefined;
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
  const backendMode = isLocalAgentId(agentId) ? "local" : resolveBackendMode();
  const managedCloudSandbox = isManagedCloudSandbox();
  const localSchedulesAllowed = allowsLocalCloudSchedules();
  const cloudServer = isCloudServerUrl();
  if (
    backendMode === "local" ||
    (!managedCloudSandbox && localSchedulesAllowed)
  ) {
    return resolveCronRunner({
      managedCloudSandbox,
      backendMode,
      localSchedulesAllowed,
    });
  }
  const deviceId =
    getRuntimeContext()?.environmentDeviceId?.trim() ||
    process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID?.trim();
  let listenerDeviceId: string | undefined;
  if (!managedCloudSandbox && deviceId) {
    const environment = await lookupEnvironmentForTarget(deviceId);
    if (environment && validateTargetDevice(deviceId, environment).ok) {
      listenerDeviceId = deviceId;
    }
  }
  await ensureSettingsForCloud();
  const cloudSchedulesSupported = await probeCloudScheduleSupport(agentId);
  return resolveCronRunner({
    managedCloudSandbox,
    backendMode,
    cloudSchedulesSupported,
    listenerDeviceId,
    localSchedulesAllowed,
    cloudServer,
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
      error: "Choose a computer from `letta computers list`.",
    };
  }

  if (deviceId === SYNTHETIC_LOCAL_PLACEHOLDER_ID) {
    return {
      ok: false,
      error:
        "Choose a connected computer from `letta computers list`. Run `letta server` on that computer to connect it.",
    };
  }

  if (environment?.organizationId === "local") {
    return {
      ok: false,
      error: `Device ${deviceId} is not connected to your account. Run \`letta server\` on that computer to connect it.`,
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

type TargetDeviceResolution =
  | { deviceId: string; environment: EnvironmentConnection }
  | { error: string };

/**
 * Resolve a `--computer` selector to the computer's deviceId, matching the
 * Agent tool's selector forms (connection id, environment id, deviceId, or
 * name). The Cloud schedule API only accepts deviceIds, so passing the `id`
 * column from `letta computers list` would otherwise earn a 404.
 *
 * Offline computers still resolve: schedules may target them. Returns null
 * when the environments list is unavailable so the caller can fall back to
 * the raw value and leave the server authoritative.
 */
async function resolveTargetDeviceSelector(
  selector: string,
): Promise<TargetDeviceResolution | null> {
  let environments: typeof import("@/backend/api/environments");
  let response: Awaited<ReturnType<typeof environments.listEnvironments>>;
  try {
    environments = await import("@/backend/api/environments");
    response = await environments.listEnvironments({ limit: 100 });
  } catch {
    return null;
  }

  const matches = response.connections.filter((environment) =>
    environments.environmentMatchesSelector(environment, selector),
  );
  if (matches.length === 0) {
    // A truncated list cannot prove absence; let the server decide.
    if (response.hasNextPage) return null;
    return {
      error: `Computer "${selector}" not found. Run \`letta computers list\` and pass its deviceId (or name).`,
    };
  }

  if (new Set(matches.map((environment) => environment.deviceId)).size > 1) {
    return {
      error: `Computer "${selector}" is ambiguous. Matched: ${matches.map(environments.describeEnvironment).join(", ")}. Pass a deviceId instead.`,
    };
  }

  // Several listener rows for one device are still one computer; prefer the
  // most recently active row for the organization check.
  matches.sort(
    (a, b) =>
      Math.max(b.lastHeartbeat ?? 0, b.lastSeenAt) -
      Math.max(a.lastHeartbeat ?? 0, a.lastSeenAt),
  );
  const environment = matches[0];
  if (!environment) return null;
  return { deviceId: environment.deviceId, environment };
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
 * Both `letta cron` and Wake use this path. Registered listeners default to
 * their own device; `--computer` overrides the target of a Cloud schedule.
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
      error: "--computer isn't available here.",
    };
  }

  if (!targetDeviceId) {
    return {
      runner: resolved.runner,
      ...(resolved.targetDeviceId && {
        targetDeviceId: resolved.targetDeviceId,
      }),
    };
  }

  const selectorValidity = validateTargetDevice(targetDeviceId, null);
  if (!selectorValidity.ok) return selectorValidity;

  const resolution = await resolveTargetDeviceSelector(targetDeviceId);
  if (!resolution) {
    const validity = validateTargetDevice(
      targetDeviceId,
      await lookupEnvironmentForTarget(targetDeviceId),
    );
    if (!validity.ok) return validity;
    return { runner: resolved.runner, targetDeviceId };
  }
  if ("error" in resolution) return resolution;

  const validity = validateTargetDevice(
    resolution.deviceId,
    resolution.environment,
  );
  if (!validity.ok) return validity;
  return { runner: resolved.runner, targetDeviceId: resolution.deviceId };
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
  /** Optional connected computer to execute on (offline → occurrence fails, no fallback). */
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
  "Recurring schedules interpret cron expressions in UTC.";

export const CLOUD_DEVICE_OFFLINE_NOTE =
  "If the target computer is offline when the schedule fires, that occurrence fails (TARGET_DEVICE_UNAVAILABLE) and does not run.";

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
      throw new Error("One-shot schedules require a resolved --at time.");
    }
    schedule = { type: "one-time", scheduled_at: scheduledAt };
  }

  const targetDeviceId = params.targetDeviceId?.trim();
  if (targetDeviceId) {
    notes.push(CLOUD_DEVICE_OFFLINE_NOTE);
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
