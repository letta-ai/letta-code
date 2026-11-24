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
  launch_subagent_notify_caller?: boolean;
  external_fork_context?: boolean;
  subagent_message?: boolean;
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

export const SUBAGENT_CLOUD_OPTIONS_ENV = "LETTA_SUBAGENT_CLOUD_OPTIONS";

export interface AgentSandboxOptions {
  githubRepositories?: Array<{ owner: string; repo: string; commit?: string }>;
  sandboxSize?: "regular" | "large" | "xlarge";
}

export async function createAgentSandbox(
  agentId: string,
  options: AgentSandboxOptions & { conversationId?: string } = {},
  request: typeof apiRequest = apiRequest,
): Promise<CreateAgentSandboxResponse> {
  const conversationId =
    options.conversationId === "default" ? undefined : options.conversationId;
  return request<CreateAgentSandboxResponse>(
    "POST",
    `/v1/agents/${encodeURIComponent(agentId)}/sandboxes`,
    {
      ...(conversationId && { conversationId }),
      ...(options.githubRepositories !== undefined && {
        githubRepositories: options.githubRepositories,
      }),
      ...(options.sandboxSize !== undefined && {
        sandboxSize: options.sandboxSize,
      }),
    },
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
      ((environment.deviceId.startsWith("desktop:") &&
        environment.listenerInstanceId?.startsWith("desktop-primary:") ===
          true) ||
        environment.listenerInstanceId?.startsWith("desktop-direct-cloud:") ===
          true) &&
      environment.organizationId !== "local" &&
      isEnvironmentOnline(environment),
  );

  if (matches.length === 0) {
    throw new Error(
      "No Desktop Local computer is online. Run `letta teleport list` and choose a connected computer by name, device ID, or connection ID. To connect a computer, run `letta server` on it.",
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple Desktop computers are online. Run \`letta teleport list\` and choose one by name, device ID, or connection ID. Matched: ${matches.map(describeEnvironment).join(", ")}`,
    );
  }

  const environment = matches[0];
  if (!environment?.connectionId) {
    throw new Error("Desktop Local has no active connection id");
  }
  return { connectionId: environment.connectionId, environment };
}

export function environmentMatchesSelector(
  environment: EnvironmentConnection,
  selector: string,
): boolean {
  return (
    environment.connectionId === selector ||
    environment.id === selector ||
    environment.deviceId === selector ||
    environment.connectionName === selector
  );
}

export class ComputerResolutionError extends Error {
  readonly httpStatus: number | undefined;

  constructor(
    public readonly code:
      | "computer_selector_empty"
      | "computer_not_found"
      | "computer_offline"
      | "computer_ambiguous"
      | "cloud_conversation_create_failed"
      | "cloud_sandbox_create_failed"
      | "cloud_sandbox_register_timeout"
      | "cloud_sandbox_online_timeout",
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ComputerResolutionError";
    if (cause && typeof cause === "object" && "status" in cause) {
      const status = cause.status;
      if (
        typeof status === "number" &&
        Number.isInteger(status) &&
        status >= 400 &&
        status <= 599
      ) {
        this.httpStatus = status;
      }
    }
  }
}

export async function resolveEnvironmentConnectionId(
  selector: string,
  list: typeof listEnvironments = listEnvironments,
): Promise<{ connectionId: string; environment: EnvironmentConnection }> {
  const trimmed = selector.trim();
  if (!trimmed) {
    throw new ComputerResolutionError(
      "computer_selector_empty",
      "Computer selector must not be empty",
    );
  }

  const response = await list({ limit: 100 });
  const matches = response.connections.filter((environment) =>
    environmentMatchesSelector(environment, trimmed),
  );

  if (matches.length === 0) {
    throw new ComputerResolutionError(
      "computer_not_found",
      `Computer "${trimmed}" not found. Run \`letta computers list\` to discover available computers.`,
    );
  }

  const onlineMatches = matches.filter(isEnvironmentOnline);
  if (onlineMatches.length === 0) {
    throw new ComputerResolutionError(
      "computer_offline",
      `Computer "${trimmed}" is offline. Matched: ${matches.map(describeEnvironment).join(", ")}`,
    );
  }

  if (
    new Set(onlineMatches.map((environment) => environment.deviceId)).size > 1
  ) {
    throw new ComputerResolutionError(
      "computer_ambiguous",
      `Computer "${trimmed}" is ambiguous. Matched: ${onlineMatches.map(describeEnvironment).join(", ")}`,
    );
  }

  onlineMatches.sort(
    (a, b) =>
      Math.max(b.lastHeartbeat ?? 0, b.lastSeenAt) -
      Math.max(a.lastHeartbeat ?? 0, a.lastSeenAt),
  );
  const environment = onlineMatches[0];
  if (!environment) {
    throw new ComputerResolutionError(
      "computer_offline",
      `Computer "${trimmed}" is offline`,
    );
  }
  if (!environment.connectionId) {
    throw new Error(`Computer "${trimmed}" has no active connection id`);
  }

  return { connectionId: environment.connectionId, environment };
}

export async function resolveAgentSandboxConnectionId(
  agentId: string,
  options: AgentSandboxOptions & {
    conversationId?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  } = {},
): Promise<{ connectionId: string; environment: EnvironmentConnection }> {
  const timeoutMs = options.timeoutMs ?? 3 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  let deviceId: string;
  let connectionName: string;
  try {
    const sandbox = await createAgentSandbox(agentId, options);
    deviceId = sandbox.deviceId || `sandbox-${agentId}`;
    connectionName = sandbox.connectionName;
  } catch (error) {
    throw new ComputerResolutionError(
      "cloud_sandbox_create_failed",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
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
    throw new ComputerResolutionError(
      "cloud_sandbox_online_timeout",
      `Timed out waiting for cloud sandbox ${connectionName} to come online. Last status: ${describeEnvironment(lastEnvironment)}`,
      lastError,
    );
  }

  throw new ComputerResolutionError(
    "cloud_sandbox_register_timeout",
    `Timed out waiting for cloud sandbox ${connectionName} to register${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
    lastError,
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

export function getTeleportStatus(
  agentId: string,
  conversationId: string,
  teleportId: string,
  request: typeof apiRequest = apiRequest,
): Promise<TeleportResponse> {
  return request<TeleportResponse>(
    "GET",
    `/v1/environments/runtimes/${encodeURIComponent(agentId)}/${encodeURIComponent(conversationId)}/teleports/${encodeURIComponent(teleportId)}`,
    undefined,
    { signal: AbortSignal.timeout(5000) },
  );
}

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
