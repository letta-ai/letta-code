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
  const byStableKey = (
    left: McpServerNamingTarget,
    right: McpServerNamingTarget,
  ) => left.key.localeCompare(right.key);
  const ordered = [
    ...targets.filter((target) => target.kind === "server").sort(byStableKey),
    ...targets.filter((target) => target.kind === "client").sort(byStableKey),
  ];
  for (const target of ordered) {
    aliases.set(
      target.key,
      uniqueMcpName(normalizeMcpName(target.name).replace(/_{2,}/g, "_"), used),
    );
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
