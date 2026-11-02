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
  /** Accepts `launch_subagent` with `notify: "caller"`. */
  launch_subagent_notify_caller?: boolean;
  /** Supports steering and stopping remote external subagents. */
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

/** A repository the Cloud sandbox clones to `/root/workspace/<repo>`. */
export interface SandboxGithubRepository {
  owner: string;
  repo: string;
  /** Full 40-character commit SHA to check out. */
  commit?: string;
}

/**
 * A requested repository before branch resolution. The sandbox endpoint only
 * takes a commit SHA, so a `branch` is resolved to one before the request.
 */
export type SandboxRepositorySpec = SandboxGithubRepository & {
  branch?: string;
};

/** Cloud accepts at most this many repositories per sandbox request. */
export const MAX_SANDBOX_GITHUB_REPOSITORIES = 10;

const SANDBOX_REPOSITORY_SPEC =
  /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(?:@(.+))?$/;
const COMMIT_SHA = /^[0-9a-fA-F]{40}$/;
/**
 * A conservative subset of `git check-ref-format --branch`: no leading `-`
 * (it is never read as an option), no `..`, `@{`, `//`, or `.lock` suffix.
 */
const BRANCH_NAME =
  /^(?![-/.])(?!.*\.\.)(?!.*@\{)(?!.*\/\/)(?!.*[/.]$)(?!.*\.lock$)[A-Za-z0-9._/+@#=-]{1,200}$/;

function invalidRepoSpec(spec: unknown): { error: string } {
  return {
    error: `Invalid repo ${JSON.stringify(spec)}: use "owner/repo", "owner/repo@<branch>", or "owner/repo@<40-character commit SHA>"`,
  };
}

/**
 * Parse `owner/repo`, `owner/repo@<commit>`, or `owner/repo@<branch>` specs.
 * A 40-character hex ref is always a commit. Owner, repo, and commit patterns
 * mirror what the Cloud sandbox endpoint accepts, so a bad spec fails here
 * with a readable message instead of as a 400.
 */
export function parseSandboxRepositorySpecs(
  specs: unknown,
  options: { allowBranches?: boolean } = {},
): { repositories: SandboxRepositorySpec[] } | { error: string } {
  if (specs === undefined) return { repositories: [] };
  if (!Array.isArray(specs) || specs.length > MAX_SANDBOX_GITHUB_REPOSITORIES)
    return {
      error: `repos must be a list of at most ${MAX_SANDBOX_GITHUB_REPOSITORIES} repositories`,
    };
  const allowBranches = options.allowBranches ?? true;
  const repositories: SandboxRepositorySpec[] = [];
  for (const spec of specs) {
    const match =
      typeof spec === "string"
        ? SANDBOX_REPOSITORY_SPEC.exec(spec.trim())
        : null;
    if (!match?.[1] || !match[2]) return invalidRepoSpec(spec);
    const ref = match[3];
    const base = { owner: match[1], repo: match[2] };
    if (ref === undefined) repositories.push(base);
    else if (COMMIT_SHA.test(ref)) repositories.push({ ...base, commit: ref });
    else if (allowBranches && BRANCH_NAME.test(ref))
      repositories.push({ ...base, branch: ref });
    else return invalidRepoSpec(spec);
  }
  const names = repositories.map(({ repo }) => repo);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate)
    return {
      error: `repos lists "${duplicate}" twice; each repository clones to /root/workspace/<repo>, so repo names must be unique`,
    };
  return { repositories };
}

const CLOUD_SANDBOX_REPOSITORIES_PREFIX = "cloud:";

/**
 * Selector for a fresh Cloud sandbox that clones `repositories`. A Letta
 * subagent receives its computer as one `--computer` value, so the requested
 * repositories travel inside it: `cloud:owner/repo,owner/repo@<commit>`.
 */
export function cloudSandboxSelector(
  repositories: SandboxGithubRepository[],
): string {
  if (repositories.length === 0) return "cloud";
  const specs = repositories.map(
    ({ owner, repo, commit }) =>
      `${owner}/${repo}${commit ? `@${commit}` : ""}`,
  );
  return `${CLOUD_SANDBOX_REPOSITORIES_PREFIX}${specs.join(",")}`;
}

/** Repositories carried by a `cloud:` selector; plain `cloud` has none. */
export function cloudSandboxSelectorRepositories(
  selector: string,
): SandboxGithubRepository[] {
  const value = selector.trim();
  if (!value.toLowerCase().startsWith(CLOUD_SANDBOX_REPOSITORIES_PREFIX))
    return [];
  // Branches are resolved to commits before the selector is built.
  const parsed = parseSandboxRepositorySpecs(
    value.slice(CLOUD_SANDBOX_REPOSITORIES_PREFIX.length).split(","),
    { allowBranches: false },
  );
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.repositories;
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
  options: {
    conversationId?: string;
    githubRepositories?: SandboxGithubRepository[];
  } = {},
  request: typeof apiRequest = apiRequest,
): Promise<CreateAgentSandboxResponse> {
  const conversationId =
    options.conversationId === "default" ? undefined : options.conversationId;
  const githubRepositories = options.githubRepositories ?? [];
  return request<CreateAgentSandboxResponse>(
    "POST",
    `/v1/agents/${encodeURIComponent(agentId)}/sandboxes`,
    {
      ...(conversationId ? { conversationId } : {}),
      ...(githubRepositories.length > 0 ? { githubRepositories } : {}),
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

/** Whether a computer selector names this environment by connection id, id, device id, or name. */
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

export async function resolveEnvironmentConnectionId(
  selector: string,
  list: typeof listEnvironments = listEnvironments,
): Promise<{ connectionId: string; environment: EnvironmentConnection }> {
  const trimmed = selector.trim();
  if (!trimmed) {
    throw new Error("Computer selector must not be empty");
  }

  const response = await list({ limit: 100 });
  const matches = response.connections.filter((environment) =>
    environmentMatchesSelector(environment, trimmed),
  );

  if (matches.length === 0) {
    throw new Error(
      `Computer "${trimmed}" not found. Run \`letta computers list\` to discover available computers.`,
    );
  }

  const onlineMatches = matches.filter(isEnvironmentOnline);
  if (onlineMatches.length === 0) {
    throw new Error(
      `Computer "${trimmed}" is offline. Matched: ${matches.map(describeEnvironment).join(", ")}`,
    );
  }

  if (
    new Set(onlineMatches.map((environment) => environment.deviceId)).size > 1
  ) {
    throw new Error(
      `Computer "${trimmed}" is ambiguous. Matched: ${onlineMatches.map(describeEnvironment).join(", ")}`,
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
    throw new Error(`Computer "${trimmed}" is offline`);
  }
  if (!environment.connectionId) {
    throw new Error(`Computer "${trimmed}" has no active connection id`);
  }

  return { connectionId: environment.connectionId, environment };
}

export async function resolveAgentSandboxConnectionId(
  agentId: string,
  options: {
    conversationId?: string;
    githubRepositories?: SandboxGithubRepository[];
    timeoutMs?: number;
    pollIntervalMs?: number;
  } = {},
): Promise<{ connectionId: string; environment: EnvironmentConnection }> {
  const timeoutMs = options.timeoutMs ?? 3 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const sandbox = await createAgentSandbox(agentId, {
    conversationId: options.conversationId,
    githubRepositories: options.githubRepositories,
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
