import type { McpServerConfig } from "@/mcp-client";
import { connectMcpEvents } from "@/mcp-events";
import {
  loadMcpToolArgs,
  McpCliError,
  type McpOutput,
  type ParsedMcpArgs,
  stringValue,
} from "./mcp-io";

export async function runMcpEvents(
  parsed: ParsedMcpArgs,
  servers: readonly McpServerConfig[],
  deps: Parameters<typeof loadMcpToolArgs>[2],
  stdout: McpOutput,
): Promise<number> {
  const config = servers.find((server) => server.name === parsed.target);
  if (!config) {
    throw new McpCliError(
      "unknown_server",
      "Pass the exact name of a locally configured MCP server",
    );
  }
  if (config.transport === "http" || config.transport === "sse") {
    throw new McpCliError(
      "unsupported_transport",
      "MCP Events requires a locally configured stdio server",
    );
  }
  const event = stringValue(parsed.values.event);
  if (parsed.action === "watch-event" && !event) {
    throw new McpCliError("invalid_arguments", "Pass --event <name> to watch");
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const connection = await connectMcpEvents(config, controller.signal);
    try {
      if (event && parsed.action === "watch-event") {
        const args = await loadMcpToolArgs(
          stringValue(parsed.values.args),
          stringValue(parsed.values["args-file"]),
          deps,
        );
        await connection.watch(
          event,
          args,
          async (notice) => {
            await stdout(JSON.stringify(notice));
          },
          controller.signal,
        );
      } else {
        await stdout(JSON.stringify(await connection.list()));
      }
    } finally {
      await connection.close();
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  return 0;
}
