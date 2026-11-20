import { getCloudToolsClient, listCloudTools } from "@/backend/api/cloud-tools";
import type { UnifiedMcpClient } from "@/backend/api/unified-mcp";
import type { StdioMcpServerConfig } from "@/mcp-client";
import { getMcpRelayEnv, MCP_RELAY_ENV_NAMES } from "@/utils/mcp-relay-env";
import { resolveLettaInvocation } from "./shell-env";

/** Ephemeral configuration; credentials are inherited, never written to settings. */
export async function discoverCloudToolsConfig(
  env: NodeJS.ProcessEnv = process.env,
  client?: UnifiedMcpClient,
): Promise<StdioMcpServerConfig | null> {
  try {
    const catalog = await listCloudTools(
      client ?? (await getCloudToolsClient(env)),
    );
    if (!catalog.tools.length) return null;
    const invocation = resolveLettaInvocation(env) ?? {
      command: "letta",
      args: [],
    };
    return {
      name: catalog.serverName,
      transport: "stdio",
      command: invocation.command,
      args: [...invocation.args, "mcp", "serve"],
      env: getMcpRelayEnv(env),
    };
  } catch {
    // Unsupported hosts and callers without proof have no additional server.
    return null;
  }
}

export function nativeCloudToolsConfig(config: StdioMcpServerConfig | null) {
  return config
    ? {
        [config.name]: {
          command: config.command,
          args: config.args,
          env: Object.fromEntries(
            MCP_RELAY_ENV_NAMES.map((name) => [name, `${"${"}${name}:-}`]),
          ),
        },
      }
    : {};
}

export function cloudToolsConfigArgs(
  config: StdioMcpServerConfig | null,
): string[] {
  if (!config) return [];
  const prefix = `mcp_servers.${JSON.stringify(config.name)}`;
  return [
    "-c",
    `${prefix}.command=${JSON.stringify(config.command)}`,
    "-c",
    `${prefix}.args=${JSON.stringify(config.args ?? [])}`,
    "-c",
    `${prefix}.env_vars=${JSON.stringify(MCP_RELAY_ENV_NAMES)}`,
  ];
}
