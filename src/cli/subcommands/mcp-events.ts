import type { McpOAuthConnection, McpServerConfig } from "@/mcp-client";
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
  scope: { agentId: string; conversationId?: string },
  oauthForConfig: (
    config: McpServerConfig,
  ) => Promise<McpOAuthConnection | undefined>,
): Promise<number> {
  const config = servers.find((server) => server.name === parsed.target);
  if (!config) {
    throw new McpCliError(
      "unknown_server",
      "Pass the exact name of a locally configured MCP server",
    );
  }
  if (config.transport === "sse") {
    throw new McpCliError(
      "unsupported_transport",
      "MCP Events requires stdio or Streamable HTTP",
    );
  }
  const event = parsed.event;
  if (parsed.action === "watch" && !event) {
    throw new McpCliError(
      "invalid_arguments",
      "Usage: letta mcp watch <server> <event>",
    );
  }
  const delivery = stringValue(parsed.values.delivery);
  if (
    delivery !== undefined &&
    delivery !== "poll" &&
    delivery !== "push" &&
    delivery !== "webhook"
  ) {
    throw new McpCliError(
      "invalid_arguments",
      "Use --delivery poll, push, or webhook",
    );
  }
  function milliseconds(key: "max-age-ms" | "min-poll-ms", minimum: number) {
    const raw = stringValue(parsed.values[key]);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum) {
      throw new McpCliError("invalid_arguments", `Invalid --${key}`);
    }
    return value;
  }
  const maxAgeMs = milliseconds("max-age-ms", 0);
  const minPollMs = milliseconds("min-poll-ms", 1);
  if (
    !event &&
    (delivery || maxAgeMs !== undefined || minPollMs !== undefined)
  ) {
    throw new McpCliError(
      "invalid_arguments",
      "Delivery options require mcp watch",
    );
  }
  const webhookUrl = stringValue(parsed.values["webhook-url"]);
  const webhookPort = stringValue(parsed.values["webhook-port"]);
  if ((webhookUrl || webhookPort) && !event) {
    throw new McpCliError(
      "invalid_arguments",
      "Webhook options require mcp watch",
    );
  }
  if (webhookPort && !webhookUrl) {
    throw new McpCliError(
      "invalid_arguments",
      "--webhook-port requires --webhook-url",
    );
  }
  const port = Number(webhookPort ?? "8765");
  const url = webhookUrl ? new URL(webhookUrl) : undefined;
  if (
    url &&
    (url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535)
  ) {
    throw new McpCliError(
      "invalid_arguments",
      "Use an HTTPS callback URL and a valid local receiver port",
    );
  }
  const args = event
    ? await loadMcpToolArgs(
        stringValue(parsed.values.args),
        stringValue(parsed.values["args-file"]),
        deps,
      )
    : {};
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const oauth = await oauthForConfig(config);
    const connection = await connectMcpEvents(config, {
      signal: controller.signal,
      oauth,
    });
    try {
      if (event) {
        await connection.watch(
          event,
          args,
          async (notice) => {
            await stdout(
              JSON.stringify(
                notice.type === "event"
                  ? { ...notice, trust: "untrusted" }
                  : notice,
              ),
            );
          },
          controller.signal,
          url ? { url, port } : undefined,
          { ...scope, delivery, maxAgeMs, minPollMs },
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
