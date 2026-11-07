import { randomUUID } from "node:crypto";
import {
  type EnvironmentConnection,
  listEnvironments,
  resolveEnvironmentConnectionId,
} from "@/backend/api/environments";
import type { AgentRuntimeScope } from "@/types/runtime-scope";
import type { ExecuteCommandResponseMessage } from "@/types/task-control-protocol";

export const UPGRADE_COMMAND_ID = "upgrade-letta-code";
export const DEFAULT_UPGRADE_TIMEOUT_MS = 5 * 60_000;

export type UpgradeCommandPayload = {
  type: "execute_command";
  command_id: typeof UPGRADE_COMMAND_ID;
  request_id: string;
  runtime: AgentRuntimeScope;
};

/** Sends one execute_command frame and resolves with its matching response. */
export type SendUpgradeCommand = (params: {
  connectionId: string;
  payload: UpgradeCommandPayload;
  timeoutMs: number;
}) => Promise<ExecuteCommandResponseMessage>;

export type ComputersUpgradeDeps = {
  listEnvironments?: typeof listEnvironments;
  sendCommand?: SendUpgradeCommand;
  timeoutMs?: number;
};

export type ComputersUpgradeOptions = {
  selector: string;
  scope: AgentRuntimeScope;
  json: boolean;
};

type RawExecuteCommandResponse = ExecuteCommandResponseMessage &
  Record<string, unknown>;

function isExecuteCommandResponse(
  requestId: string,
): (message: unknown) => message is RawExecuteCommandResponse {
  return (message): message is RawExecuteCommandResponse =>
    !!message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "execute_command_response" &&
    (message as { request_id?: unknown }).request_id === requestId;
}

/** Open the computer's Cloud status socket and wait for the listener's reply. */
async function sendUpgradeCommandOverStatusSocket(params: {
  connectionId: string;
  payload: UpgradeCommandPayload;
  timeoutMs: number;
}): Promise<ExecuteCommandResponseMessage> {
  const [{ default: WebSocket }, { createAppServerClient }, request, launch] =
    await Promise.all([
      import("ws"),
      import("@/app-server-client"),
      import("@/backend/api/request"),
      import("@/headless-listener-launch"),
    ]);
  const auth = await request.getApiRequestConfig();
  const client = createAppServerClient({
    url: launch.listenerControlUrl(
      auth.baseUrl,
      params.connectionId,
      params.payload.runtime,
    ),
    authToken: auth.apiKey,
    WebSocket,
    requestTimeoutMs: params.timeoutMs,
  });
  try {
    await client.connect();
    return await client.requestRaw(params.payload, {
      timeoutMs: params.timeoutMs,
      predicate: isExecuteCommandResponse(params.payload.request_id),
    });
  } finally {
    client.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(
  options: ComputersUpgradeOptions,
  message: string,
  environment?: EnvironmentConnection,
): number {
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          success: false,
          ...(environment ? describeForJson(environment) : {}),
          error: message,
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`Error: ${message}`);
  }
  return 1;
}

function describeForJson(environment: EnvironmentConnection) {
  return {
    id: environment.id,
    deviceId: environment.deviceId,
    connectionName: environment.connectionName,
    connectionId: environment.connectionId ?? null,
    previousVersion: environment.metadata?.lettaCodeVersion ?? null,
  };
}

/** Ask a connected computer's listener to update letta-code and restart. */
export async function runComputersUpgrade(
  options: ComputersUpgradeOptions,
  deps: ComputersUpgradeDeps = {},
): Promise<number> {
  let resolved: { connectionId: string; environment: EnvironmentConnection };
  try {
    resolved = await resolveEnvironmentConnectionId(
      options.selector,
      deps.listEnvironments ?? listEnvironments,
    );
  } catch (error) {
    return fail(options, errorMessage(error));
  }
  const { connectionId, environment } = resolved;

  const supported = environment.metadata?.supported_commands;
  if (!Array.isArray(supported) || !supported.includes(UPGRADE_COMMAND_ID)) {
    return fail(
      options,
      `Computer "${environment.connectionName}" does not support remote upgrades (its listener does not advertise "${UPGRADE_COMMAND_ID}"). Run \`letta update\` on that computer instead.`,
      environment,
    );
  }

  const currentVersion = environment.metadata?.lettaCodeVersion ?? "unknown";
  if (!options.json) {
    console.log(
      `Upgrading ${environment.connectionName} (${environment.deviceId}), current version ${currentVersion}...`,
    );
  }

  const payload: UpgradeCommandPayload = {
    type: "execute_command",
    command_id: UPGRADE_COMMAND_ID,
    request_id: randomUUID(),
    runtime: options.scope,
  };
  const timeoutMs = deps.timeoutMs ?? DEFAULT_UPGRADE_TIMEOUT_MS;

  let response: ExecuteCommandResponseMessage;
  try {
    response = await (deps.sendCommand ?? sendUpgradeCommandOverStatusSocket)({
      connectionId,
      payload,
      timeoutMs,
    });
  } catch (error) {
    return fail(
      options,
      `Upgrade request to ${environment.connectionName} failed: ${errorMessage(error)}`,
      environment,
    );
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          success: response.success,
          ...describeForJson(environment),
          output: response.output,
        },
        null,
        2,
      ),
    );
  } else if (response.success) {
    console.log(response.output);
  } else {
    console.error(`Error: ${response.output}`);
  }
  return response.success ? 0 : 1;
}
