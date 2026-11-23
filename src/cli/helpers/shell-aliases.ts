import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let aliasCache: Map<string, string> | null = null;

const ALIAS_FILES = [
  ".zshrc",
  ".bashrc",
  ".bash_aliases",
  ".zsh_aliases",
  ".aliases",
  ".shell_aliases",
];

function parseAliasesFromFile(filePath: string): Map<string, string> {
  const aliases = new Map<string, string>();

  if (!existsSync(filePath)) {
    return aliases;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    let inFunction = false;
    let functionName = "";
    let functionBody = "";
    let braceDepth = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      if (inFunction) {
        functionBody += `${line}\n`;
        braceDepth += (line.match(/{/g) || []).length;
        braceDepth -= (line.match(/}/g) || []).length;

        if (braceDepth === 0) {
          aliases.set(functionName, `__LETTA_FUNC__${functionBody}`);
          inFunction = false;
          functionName = "";
          functionBody = "";
        }
        continue;
      }

      if (trimmed.startsWith("#") || !trimmed) {
        continue;
      }

      const funcMatch =
        trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\)\s*\{?/) ||
        trimmed.match(/^function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\{?/);
      if (funcMatch?.[1]) {
        functionName = funcMatch[1];
        functionBody = `${line}\n`;
        braceDepth =
          (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;

        if (braceDepth > 0) {
          inFunction = true;
        } else if (
          braceDepth === 0 &&
          line.includes("{") &&
          line.includes("}")
        ) {
          aliases.set(functionName, `__LETTA_FUNC__${functionBody}`);
          functionName = "";
          functionBody = "";
        }
        continue;
      }

      const aliasMatch = trimmed.match(/^alias\s+([a-zA-Z0-9_-]+)=(.+)$/);
      if (aliasMatch) {
        const [, name, rawValue] = aliasMatch;
        if (!name || !rawValue) continue;
        let value = rawValue.trim();

        if (
          (value.startsWith("'") && value.endsWith("'")) ||
          (value.startsWith('"') && value.endsWith('"'))
        ) {
          value = value.slice(1, -1);
        }

        value = value.replace(/\\'/g, "'").replace(/\\"/g, '"');

        if (name && value) {
          aliases.set(name, value);
        }
      }
    }
  } catch (_error) {}

  return aliases;
}

export function loadAliases(forceReload = false): Map<string, string> {
  if (aliasCache && !forceReload) {
    return aliasCache;
  }

  const home = homedir();
  const allAliases = new Map<string, string>();

  for (const file of ALIAS_FILES) {
    const filePath = join(home, file);
    const fileAliases = parseAliasesFromFile(filePath);

    for (const [name, value] of fileAliases) {
      allAliases.set(name, value);
    }
  }

  aliasCache = allAliases;
  return allAliases;
}

export interface ExpandedCommand {
  command: string;
  functionDef?: string;
}

export function expandAliases(command: string, maxDepth = 10): ExpandedCommand {
  const aliases = loadAliases();

  if (aliases.size === 0) {
    return { command };
  }

  const trimmed = command.trim();
  const firstSpaceIdx = trimmed.indexOf(" ");
  const firstWord =
    firstSpaceIdx === -1 ? trimmed : trimmed.slice(0, firstSpaceIdx);
  const rest = firstSpaceIdx === -1 ? "" : trimmed.slice(firstSpaceIdx);

  const aliasValue = aliases.get(firstWord);

  if (aliasValue?.startsWith("__LETTA_FUNC__")) {
    const functionDef = aliasValue.slice("__LETTA_FUNC__".length);
    return { command, functionDef };
  }

  if (!aliasValue) {
    return { command };
  }

  let expanded = aliasValue + rest;
  let depth = 1;

  while (depth < maxDepth) {
    const expandedTrimmed = expanded.trim();
    const expandedFirstSpace = expandedTrimmed.indexOf(" ");
    const expandedFirstWord =
      expandedFirstSpace === -1
        ? expandedTrimmed
        : expandedTrimmed.slice(0, expandedFirstSpace);
    const expandedRest =
      expandedFirstSpace === -1
        ? ""
        : expandedTrimmed.slice(expandedFirstSpace);

    const nextAlias = aliases.get(expandedFirstWord);
    if (!nextAlias || nextAlias.startsWith("__LETTA_FUNC__")) {
      break;
    }

    expanded = nextAlias + expandedRest;
    depth++;
  }

  return { command: expanded };
}

export function clearAliasCache(): void {
  aliasCache = null;
}
