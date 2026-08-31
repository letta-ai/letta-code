import type { McpServerConfig } from "@/mcp-client";

export type McpConfigTransport = "stdio" | "http" | "sse";

export interface BuildMcpServerConfigOptions {
  transport: McpConfigTransport;
  url?: string;
  cwd?: string;
  env: string[];
  headers: string[];
  authEnv?: string;
  childCommand: string[];
  defaultCwd: string;
}

export function parseMcpTransport(
  value: string | undefined,
): McpConfigTransport | undefined {
  const transport = value?.toLowerCase();
  if (!transport) return undefined;
  if (transport === "http" || transport === "streamable_http") return "http";
  if (transport === "stdio" || transport === "sse") return transport;
  throw new Error(`Unknown MCP transport '${transport}'`);
}

export function buildMcpServerConfig(
  name: string,
  options: BuildMcpServerConfigOptions,
): McpServerConfig {
  if (options.transport === "stdio") {
    const [command, ...args] = options.childCommand;
    if (!command) throw new Error("A stdio child command is required after --");
    const env = parseKeyValues(options.env, "--env");
    return {
      name,
      transport: "stdio",
      command,
      args,
      cwd: options.cwd ?? options.defaultCwd,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  if (!options.url) {
    throw new Error("--url is required for an HTTP or SSE connection");
  }
  try {
    new URL(options.url);
  } catch {
    throw new Error(`Invalid MCP URL '${options.url}'`);
  }
  const headers = parseHeaders(options.headers);
  if (options.authEnv) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(options.authEnv)) {
      throw new Error(`Invalid environment variable name '${options.authEnv}'`);
    }
    headers.Authorization = `Bearer \${${options.authEnv}}`;
  }
  return {
    name,
    transport: options.transport,
    url: options.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

function parseKeyValues(
  values: string[],
  option: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) throw new Error(`${option} must use KEY=VALUE`);
    result[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return result;
}

function parseHeaders(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    const colon = value.indexOf(":");
    const equals = value.indexOf("=");
    const separator = colon > 0 ? colon : equals;
    if (separator <= 0) {
      throw new Error("--header must use 'Name: value' or 'Name=value'");
    }
    result[value.slice(0, separator).trim()] = value
      .slice(separator + 1)
      .trim();
  }
  return result;
}
