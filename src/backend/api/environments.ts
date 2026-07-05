import { apiRequest } from "./request";

export interface EnvironmentMetadata {
  os?: string;
  lettaCodeVersion?: string;
  nodeVersion?: string;
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
