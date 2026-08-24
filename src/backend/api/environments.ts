import { randomUUID } from "node:crypto";
import { apiRequest } from "./request";

export interface EnvironmentMetadata {
  os?: string;
  lettaCodeVersion?: string;
  nodeVersion?: string;
  environmentMessageProtocol?: string;
  workingDirectory?: string;
  gitBranch?: string;
  supported_commands?: string[];
  [key: string]: unknown;
}

export interface EnvironmentConnection {
  id: string;
  connectionId: string | null;
  deviceId: string;
  listenerInstanceId?: string;
  connectionName: string;
  organizationId: string;
  userId?: string;
  apiKeyOwner?: string;
  podId: string | null;
  connectedAt: number | null;
  lastHeartbeat: number | null;
  lastSeenAt: number;
  firstSeenAt: number;
  currentMode?: string;
  metadata?: EnvironmentMetadata;
}

export interface ListEnvironmentsResponse {
  connections: EnvironmentConnection[];
  hasNextPage: boolean;
}

export type SendEnvironmentMessageBody = Record<string, unknown> & {
  messages: Array<Record<string, unknown>>;
  agentId?: string;
  conversationId?: string | null;
};

export interface SendEnvironmentMessageResponse {
  success: boolean;
  message: string;
}

export interface CreateAgentSandboxResponse {
  sandboxId: string;
  deviceId: string;
  connectionName: string;
}

export async function listEnvironments(
  options: { limit?: number; after?: string; onlineOnly?: boolean } = {},
): Promise<ListEnvironmentsResponse> {
  return apiRequest<ListEnvironmentsResponse>(
    "GET",
    "/v1/environments",
    undefined,
    {
      query: {
        limit: options.limit,
        after: options.after,
        onlineOnly: options.onlineOnly,
      },
    },
  );
}

export async function sendEnvironmentMessage(
  connectionId: string,
  body: SendEnvironmentMessageBody,
): Promise<SendEnvironmentMessageResponse> {
  return apiRequest<SendEnvironmentMessageResponse>(
    "POST",
    `/v1/environments/${encodeURIComponent(connectionId)}/messages`,
    body,
  );
}

export async function getEnvironmentConnection(
  deviceId: string,
): Promise<EnvironmentConnection> {
  return apiRequest<EnvironmentConnection>(
    "GET",
    `/v1/environments/${encodeURIComponent(deviceId)}`,
  );
}

export async function createAgentSandbox(
  agentId: string,
  options: { conversationId?: string } = {},
  request: typeof apiRequest = apiRequest,
): Promise<CreateAgentSandboxResponse> {
  const conversationId =
    options.conversationId === "default" ? undefined : options.conversationId;
  return request<CreateAgentSandboxResponse>(
    "POST",
    `/v1/agents/${encodeURIComponent(agentId)}/sandboxes`,
    conversationId ? { conversationId } : {},
  );
}

export function isEnvironmentOnline(
  environment: EnvironmentConnection,
): boolean {
  return (
    typeof environment.connectionId === "string" &&
    environment.connectionId.length > 0 &&
    typeof environment.lastHeartbeat === "number" &&
    Date.now() - environment.lastHeartbeat < 120_000
  );
}

export function describeEnvironment(
  environment: EnvironmentConnection,
): string {
  const status = isEnvironmentOnline(environment) ? "online" : "offline";
  return `${environment.connectionName} (${environment.deviceId}, ${status})`;
}

export async function resolveDesktopEnvironmentConnectionId(
  list: typeof listEnvironments = listEnvironments,
): Promise<{ connectionId: string; environment: EnvironmentConnection }> {
  const response = await list({ limit: 100, onlineOnly: true });
  const matches = response.connections.filter(
    (environment) =>
      environment.listenerInstanceId?.startsWith("desktop-direct-cloud:") ===
        true && isEnvironmentOnline(environment),
  );

  if (matches.length === 0) {
    throw new Error(
      "Desktop Local is unavailable. Open Letta Desktop, enable Remote Access, and wait for its environment to come online.",
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple Desktop environments are online. Run \`letta teleport list\` and choose one by name, device ID, or connection ID. Matched: ${matches.map(describeEnvironment).join(", ")}`,
    );
  }

  const environment = matches[0];
  if (!environment?.connectionId) {
    throw new Error("Desktop Local has no active connection id");
  }
  return { connectionId: environment.connectionId, environment };
}

export async function resolveEnvironmentConnectionId(
  selector: string,
): Promise<{ connectionId: string; environment: EnvironmentConnection }> {
  const trimmed = selector.trim();
  if (!trimmed) {
    throw new Error("Environment selector must not be empty");
  }

  const response = await listEnvironments({ limit: 100 });
  const matches = response.connections.filter((environment) => {
    return (
      environment.connectionId === trimmed ||
      environment.id === trimmed ||
      environment.deviceId === trimmed ||
      environment.connectionName === trimmed
    );
  });

  if (matches.length === 0) {
    throw new Error(
      `Environment "${trimmed}" not found. Run \`letta environments list\` to discover available environments.`,
    );
  }

  const onlineMatches = matches.filter(isEnvironmentOnline);
  if (onlineMatches.length === 0) {
    throw new Error(
      `Environment "${trimmed}" is offline. Matched: ${matches.map(describeEnvironment).join(", ")}`,
    );
  }

  if (onlineMatches.length > 1) {
    throw new Error(
      `Environment "${trimmed}" is ambiguous. Matched: ${onlineMatches.map(describeEnvironment).join(", ")}`,
    );
  }

  const environment = onlineMatches[0];
  if (!environment) {
    throw new Error(`Environment "${trimmed}" is offline`);
  }
  if (!environment.connectionId) {
    throw new Error(`Environment "${trimmed}" has no active connection id`);
  }

  return { connectionId: environment.connectionId, environment };
}

export async function resolveAgentSandboxConnectionId(
  agentId: string,
  options: {
    conversationId?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  } = {},
): Promise<{ connectionId: string; environment: EnvironmentConnection }> {
  const timeoutMs = options.timeoutMs ?? 3 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const sandbox = await createAgentSandbox(agentId, {
    conversationId: options.conversationId,
  });
  const deviceId = sandbox.deviceId || `sandbox-${agentId}`;
  const deadline = Date.now() + timeoutMs;
  let lastEnvironment: EnvironmentConnection | null = null;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const environment = await getEnvironmentConnection(deviceId);
      lastEnvironment = environment;
      if (isEnvironmentOnline(environment) && environment.connectionId) {
        return { connectionId: environment.connectionId, environment };
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  if (lastEnvironment) {
    throw new Error(
      `Timed out waiting for cloud sandbox ${sandbox.connectionName} to come online. Last status: ${describeEnvironment(lastEnvironment)}`,
    );
  }

  throw new Error(
    `Timed out waiting for cloud sandbox ${sandbox.connectionName} to register${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
  );
}

export type TeleportStatus =
  | "waiting_for_source"
  | "starting_destination"
  | "completed"
  | "failed";

export interface TeleportResponse {
  id: string;
  agentId: string;
  conversationId: string;
  sourceConnectionId: string;
  targetConnectionId: string;
  targetDeviceId: string;
  targetConnectionName: string;
  status: TeleportStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Submit a teleport request to Cloud. Returns immediately after the 202
 * acceptance — the harness owns polling/yield after this returns.
 */
export async function teleportToEnvironment(
  agentId: string,
  conversationId: string,
  targetConnectionId: string,
  request: typeof apiRequest = apiRequest,
): Promise<TeleportResponse> {
  return request<TeleportResponse>(
    "POST",
    `/v1/environments/runtimes/${encodeURIComponent(agentId)}/${encodeURIComponent(conversationId)}/teleport`,
    {
      targetConnectionId,
      idempotencyKey: randomUUID(),
    },
  );
}
