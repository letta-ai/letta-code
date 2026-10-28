import {
  describeEnvironment,
  type EnvironmentConnection,
  type EnvironmentSource,
  getEnvironmentConnection,
  isEnvironmentOnline,
  type ListEnvironmentsOptions,
  listEnvironments,
} from "@/backend/api/environments";
import { ApiRequestError } from "@/backend/api/request";

const LOOKUP_PAGE_SIZE = 100;

interface EnvironmentLookupDeps {
  get?: typeof getEnvironmentConnection;
  list?: typeof listEnvironments;
}

function isRemoteEnvironment(environment: EnvironmentConnection): boolean {
  return (
    environment.organizationId !== "local" &&
    !environment.connectionId?.startsWith("local-")
  );
}

function matchesSource(
  environment: EnvironmentConnection,
  source: EnvironmentSource,
): boolean {
  return source === "remote"
    ? isRemoteEnvironment(environment)
    : !isRemoteEnvironment(environment);
}

function isUnsupportedSelectorError(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    (error.status === 400 || error.status === 422)
  );
}

async function listCompleteEnvironmentCollection(
  list: typeof listEnvironments,
  options: Pick<ListEnvironmentsOptions, "onlineOnly"> = {},
): Promise<EnvironmentConnection[]> {
  const connections: EnvironmentConnection[] = [];
  let after: string | undefined;

  for (;;) {
    const response = await list({
      limit: LOOKUP_PAGE_SIZE,
      ...(after ? { after } : {}),
      ...options,
    });
    connections.push(...response.connections);
    if (!response.hasNextPage) return connections;

    const next = response.connections.at(-1)?.id;
    if (!next || next === after) {
      throw new Error(
        "Environment pagination did not return a usable next cursor",
      );
    }
    after = next;
  }
}

async function tryFilteredEnvironmentList(
  list: typeof listEnvironments,
  query: Pick<ListEnvironmentsOptions, "onlineOnly" | "source">,
): Promise<EnvironmentConnection[] | null> {
  let response: Awaited<ReturnType<typeof listEnvironments>>;
  try {
    response = await list({ limit: LOOKUP_PAGE_SIZE, ...query });
  } catch (error) {
    if (isUnsupportedSelectorError(error)) return null;
    throw error;
  }

  const rowsMatch = response.connections.every(
    (environment) =>
      (query.source === undefined ||
        matchesSource(environment, query.source)) &&
      (!query.onlineOnly || isEnvironmentOnline(environment)),
  );
  if (!rowsMatch || response.hasNextPage) return null;
  return response.connections;
}

function selectEnvironment(
  selector: string,
  matches: EnvironmentConnection[],
): { connectionId: string; environment: EnvironmentConnection } {
  if (matches.length === 0) {
    throw new Error(
      `Computer "${selector}" not found. Run \`letta computers list\` to discover available computers.`,
    );
  }

  const onlineMatches = matches.filter(isEnvironmentOnline);
  if (onlineMatches.length === 0) {
    throw new Error(
      `Computer "${selector}" is offline. Matched: ${matches.map(describeEnvironment).join(", ")}`,
    );
  }

  if (
    new Set(onlineMatches.map((environment) => environment.deviceId)).size > 1
  ) {
    throw new Error(
      `Computer "${selector}" is ambiguous. Matched: ${onlineMatches.map(describeEnvironment).join(", ")}`,
    );
  }

  // Multiple listeners for one device are not multiple computers. Match the
  // picker by preferring the online listener with the most recent activity.
  onlineMatches.sort(
    (a, b) =>
      Math.max(b.lastHeartbeat ?? 0, b.lastSeenAt) -
      Math.max(a.lastHeartbeat ?? 0, a.lastSeenAt),
  );
  const environment = onlineMatches[0];
  if (!environment) {
    throw new Error(`Computer "${selector}" is offline`);
  }
  if (!environment.connectionId) {
    throw new Error(`Computer "${selector}" has no active connection id`);
  }

  return { connectionId: environment.connectionId, environment };
}

export async function resolveEnvironmentConnectionId(
  selector: string,
  deps: EnvironmentLookupDeps = {},
): Promise<{ connectionId: string; environment: EnvironmentConnection }> {
  const trimmed = selector.trim();
  if (!trimmed) {
    throw new Error("Computer selector must not be empty");
  }

  const get = deps.get ?? getEnvironmentConnection;
  const list = deps.list ?? listEnvironments;
  let pointMatch: EnvironmentConnection | undefined;
  try {
    pointMatch = await get(trimmed);
    if (
      isEnvironmentOnline(pointMatch) &&
      typeof pointMatch.connectionId === "string"
    ) {
      return selectEnvironment(trimmed, [pointMatch]);
    }
  } catch (error) {
    if (!(error instanceof ApiRequestError) || error.status !== 404)
      throw error;
  }

  // A generic selector can be a connection ID, environment ID, device ID, or
  // name. The list API can filter names, but that subset cannot prove that the
  // same string is not a higher-priority explicit ID or a local name. Read the
  // complete actor-visible collection before resolving any non-device selector.
  const connections = await listCompleteEnvironmentCollection(list);
  const explicitMatches = connections.filter(
    (environment) =>
      environment.connectionId === trimmed ||
      environment.id === trimmed ||
      environment.deviceId === trimmed,
  );
  if (pointMatch) {
    const matchesById = new Map(
      [pointMatch, ...explicitMatches].map((environment) => [
        environment.id,
        environment,
      ]),
    );
    return selectEnvironment(trimmed, [...matchesById.values()]);
  }
  if (explicitMatches.length > 0) {
    return selectEnvironment(trimmed, explicitMatches);
  }
  return selectEnvironment(
    trimmed,
    connections.filter((environment) => environment.connectionName === trimmed),
  );
}

export async function resolveDesktopEnvironmentConnectionId(
  deps: Pick<EnvironmentLookupDeps, "list"> = {},
): Promise<{ connectionId: string; environment: EnvironmentConnection }> {
  const list = deps.list ?? listEnvironments;
  const filtered = await tryFilteredEnvironmentList(list, {
    onlineOnly: true,
    source: "remote",
  });
  const connections =
    filtered ??
    (await listCompleteEnvironmentCollection(list, { onlineOnly: true }));
  const matches = connections.filter(
    (environment) =>
      ((environment.deviceId.startsWith("desktop:") &&
        environment.listenerInstanceId?.startsWith("desktop-primary:") ===
          true) ||
        environment.listenerInstanceId?.startsWith("desktop-direct-cloud:") ===
          true) &&
      isRemoteEnvironment(environment) &&
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
