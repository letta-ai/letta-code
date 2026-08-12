import { parseArgs } from "node:util";
import { isLocalAgentId } from "@/agent/agent-id";
import {
  type EnvironmentConnection,
  listEnvironments,
  resolveAgentSandboxConnectionId,
  resolveEnvironmentConnectionId,
  teleportToEnvironment,
} from "@/backend/api/environments";
import { ApiRequestError } from "@/backend/api/request";
import { type SessionRef, settingsManager } from "@/settings-manager";

interface TeleportSubcommandDeps {
  initializeSettings?: () => Promise<void>;
  getLastSession?: () => SessionRef | null;
  listEnvironments?: typeof listEnvironments;
  resolveEnvironmentConnectionId?: typeof resolveEnvironmentConnectionId;
  resolveAgentSandboxConnectionId?: typeof resolveAgentSandboxConnectionId;
  teleportToEnvironment?: typeof teleportToEnvironment;
}

const TELEPORT_OPTIONS = {
  help: { type: "boolean", short: "h" },
} as const;

function printUsage(): void {
  console.log(
    `
Usage:
  letta teleport list
  letta teleport cloud
  letta teleport <environment>

Notes:
  - Operates on the current agent/conversation from LETTA_AGENT_ID /
    LETTA_CONVERSATION_ID (or AGENT_ID / CONVERSATION_ID), falling back to the
    last active session.
  - Requires a Letta Cloud agent and a non-virtual conversation.
  - list: prints accessible online remote environments as JSON.
  - cloud: teleports to the agent's Cloud sandbox.
  - <environment>: teleports to a specific remote environment by name,
    device-id, connection-id, or environment id.
  - Desktop Local is not a teleport target yet. Use the Desktop environment
    picker to switch back to Local.
  - Output is JSON only.
`.trim(),
  );
}

function parseTeleportArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: TELEPORT_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

function getEnvironmentSession(env: NodeJS.ProcessEnv): SessionRef | null {
  const agentId = (env.LETTA_AGENT_ID || env.AGENT_ID || "").trim();
  const conversationId = (
    env.LETTA_CONVERSATION_ID ||
    env.CONVERSATION_ID ||
    ""
  ).trim();
  if (!agentId && !conversationId) return null;
  if (!agentId || !conversationId) {
    throw new Error(
      "Both agent and conversation context are required when either is set",
    );
  }
  return { agentId, conversationId };
}

export function resolveTeleportSession(
  env: NodeJS.ProcessEnv,
  fallback: SessionRef | null,
): SessionRef {
  const session = getEnvironmentSession(env) ?? fallback;
  if (!session) {
    throw new Error("No active agent conversation found");
  }
  if (isLocalAgentId(session.agentId)) {
    throw new Error("Teleport requires a Letta Cloud agent");
  }
  if (
    !session.conversationId ||
    session.conversationId === "default" ||
    session.conversationId === "new"
  ) {
    throw new Error("Teleport requires an active conversation");
  }
  return session;
}

/**
 * Parse an API error response body `{errorCode, message}` and return a
 * concrete, human-readable message. Falls back to the raw response text
 * when the body is not valid JSON or doesn't match the expected shape.
 */
export function formatTeleportApiError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    try {
      const body = JSON.parse(error.responseText) as {
        errorCode?: string;
        message?: string;
      };
      if (typeof body.message === "string" && body.message.length > 0) {
        return body.message;
      }
      if (typeof body.errorCode === "string" && body.errorCode.length > 0) {
        return body.errorCode;
      }
    } catch {
      // Fall through to raw response text
    }
    return `API error (${error.status}): ${error.responseText}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function formatEnvironmentForList(
  environment: EnvironmentConnection,
): Record<string, unknown> {
  return {
    deviceId: environment.deviceId,
    connectionName: environment.connectionName,
    connectionId: environment.connectionId ?? null,
  };
}

function isTeleportableRemoteEnvironment(
  environment: EnvironmentConnection,
): boolean {
  return (
    environment.organizationId !== "local" &&
    !environment.connectionId?.startsWith("local-")
  );
}

function assertTeleportableRemoteEnvironment(
  environment: EnvironmentConnection,
): void {
  if (!isTeleportableRemoteEnvironment(environment)) {
    throw new Error(
      "Desktop Local is not a teleport target yet. Use the Desktop environment picker to switch back to Local.",
    );
  }
}

async function initializeTeleportSettings(): Promise<void> {
  await settingsManager.initialize();
  await settingsManager.loadLocalProjectSettings();
}

export async function runTeleportSubcommand(
  argv: string[],
  deps: TeleportSubcommandDeps = {},
): Promise<number> {
  let parsed: ReturnType<typeof parseTeleportArgs>;
  try {
    parsed = parseTeleportArgs(argv);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    printUsage();
    return 1;
  }

  const [action] = parsed.positionals;
  if (parsed.values.help || !action || action === "help") {
    printUsage();
    return 0;
  }

  try {
    await (deps.initializeSettings ?? initializeTeleportSettings)();

    if (action === "list") {
      const list = deps.listEnvironments ?? listEnvironments;
      const result = await list({ limit: 100, onlineOnly: true });
      const connections = result.connections
        .filter(isTeleportableRemoteEnvironment)
        .map(formatEnvironmentForList);
      console.log(JSON.stringify({ ...result, connections }, null, 2));
      return 0;
    }

    // cloud and <environment> both need a valid session
    const session = resolveTeleportSession(
      process.env,
      (
        deps.getLastSession ?? (() => settingsManager.getEffectiveLastSession())
      )(),
    );

    let targetConnectionId: string;

    if (action === "cloud") {
      const resolve =
        deps.resolveAgentSandboxConnectionId ?? resolveAgentSandboxConnectionId;
      const result = await resolve(session.agentId, {
        conversationId: session.conversationId,
      });
      targetConnectionId = result.connectionId;
    } else if (action === "back") {
      throw new Error(
        "Teleport back is not supported yet. Use the Desktop environment picker to switch back to Local.",
      );
    } else {
      const resolve =
        deps.resolveEnvironmentConnectionId ?? resolveEnvironmentConnectionId;
      const resolved = await resolve(action);
      assertTeleportableRemoteEnvironment(resolved.environment);
      targetConnectionId = resolved.connectionId;
    }

    const teleport = deps.teleportToEnvironment ?? teleportToEnvironment;
    const result = await teleport(
      session.agentId,
      session.conversationId,
      targetConnectionId,
    );
    // Submit-and-exit immediately after 202; the harness owns yield
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(`Error: ${formatTeleportApiError(error)}`);
    return 1;
  }
}
