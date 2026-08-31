import { formatClientMcpToolName, normalizeMcpName } from "@/mcp-runtime";

export interface McpServerNamingTarget {
  key: string;
  name: string;
  kind: "client" | "server";
}

export function uniqueMcpName(base: string, used: Set<string>): string {
  let name = base;
  let suffix = 2;
  while (used.has(name)) {
    name = `${base}_${suffix}`;
    suffix++;
  }
  used.add(name);
  return name;
}

export function assignMcpServerAliases(
  targets: McpServerNamingTarget[],
): Map<string, string> {
  const aliases = new Map<string, string>();
  const used = new Set<string>();
  const ordered = [
    ...targets.filter((target) => target.kind === "server"),
    ...targets.filter((target) => target.kind === "client"),
  ];
  for (const target of ordered) {
    aliases.set(target.key, uniqueMcpName(normalizeMcpName(target.name), used));
  }
  return aliases;
}

export function formatServerMcpToolName(
  serverName: string,
  alias: string,
  toolName: string,
): string {
  const sourcePrefix = `mcp__${normalizeMcpName(serverName)}__`;
  const rawName = toolName.startsWith(sourcePrefix)
    ? toolName.slice(sourcePrefix.length)
    : toolName;
  return formatClientMcpToolName(alias, rawName);
}
