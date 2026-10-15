import { LETTA_CODE_SUBAGENT_TAG } from "@/agent/agent-tags";
import { initializeDesktopCredentials } from "@/auth/desktop-credentials";
import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { getClient } from "@/backend/api/client";
import { setConfiguredBackendMode } from "@/backend/backend-mode";
import { LOCAL_BACKEND_EXPERIMENTAL_ENV } from "@/backend/local/paths";
import { assertSupportedBunRuntime } from "@/runtime-version";
import { settingsManager } from "@/settings-manager";
import { startOrphanDetection } from "@/utils/orphan-detection";
import { extractBackendFlag } from "./args";
import { resolveSubcommandBackendMode } from "./startup-backend-mode";
import { runMcpSubcommand } from "./subcommands/mcp";

/** Keep one-shot API MCP calls out of the agent, provider, and TUI startup graph. */
export async function tryRunMcpCli(argv: string[]): Promise<number | null> {
  let selection: ReturnType<typeof extractBackendFlag>;
  try {
    selection = extractBackendFlag(argv);
  } catch {
    // The normal entrypoint owns global argument errors.
    return null;
  }
  if (selection.args[0] !== "mcp") return null;
  const saved = settingsManager.readStartupBackendSettingsSync();
  const env = process.env[LOCAL_BACKEND_EXPERIMENTAL_ENV];
  const mode =
    selection.backend ??
    resolveSubcommandBackendMode({
      envBackendMode:
        env === undefined
          ? undefined
          : env === "1" || env.toLowerCase() === "true"
            ? "local"
            : "api",
      savedBackendMode: saved.preferredBackendMode,
      baseURL:
        process.env.LETTA_BASE_URL || saved.envBaseUrl || LETTA_CLOUD_API_URL,
      cloudBaseURL: LETTA_CLOUD_API_URL,
    }) ??
    "api";
  // Preserve local-backend initialization and migration checks on the full path.
  if (mode === "local") return null;
  assertSupportedBunRuntime();
  await initializeDesktopCredentials();
  startOrphanDetection();
  setConfiguredBackendMode("api");
  process.env[LOCAL_BACKEND_EXPERIMENTAL_ENV] = "0";
  return runMcpSubcommand(selection.args.slice(1), {
    isServerMcpAvailable: () => true,
    lookupParentAgent: async (agentId) => {
      const agent = await (await getClient()).agents.retrieve(agentId, {
        include: ["agent.tags"],
      });
      if (!agent.tags?.includes(LETTA_CODE_SUBAGENT_TAG)) return undefined;
      return agent.tags
        .find((tag) => tag.startsWith("parent:"))
        ?.slice("parent:".length);
    },
  });
}
