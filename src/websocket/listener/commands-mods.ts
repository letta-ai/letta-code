import { readdirSync } from "node:fs";
import { basename, extname } from "node:path";
import {
  disableAgentMod,
  enableAgentMod,
  readAgentModOverrides,
} from "@/mods/agent-mod-overrides";
import { isModFileExtension } from "@/mods/file-extensions";
import {
  reloadListenerModAdapter,
  resolveListenerAgentModsDirectoryForAgent,
} from "./mod-adapter";
import type { ConversationRuntime } from "./types";

/**
 * `/mods` for the remote listener: list, disable, and enable this agent's
 * MemFS mods. It runs as an execute_command, outside the mod-guarded turn, so
 * it still works when a mod's turn_start handler cancels every turn
 * (LET-12868). Disabling never edits the mod file or MemFS history.
 */

const USAGE = [
  "Usage:",
  "  /mods list",
  "  /mods disable <mod-file> [reason]",
  "  /mods enable <mod-file>",
].join("\n");

export interface ModsCommandResult {
  output: string;
  success: boolean;
}

function listAgentModFiles(modsDirectory: string): string[] {
  try {
    return readdirSync(modsDirectory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          !entry.name.startsWith(".") &&
          isModFileExtension(extname(entry.name)),
      )
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function resolveModFileName(
  requested: string,
  available: string[],
): string | null {
  const name = basename(requested.trim());
  if (!name) return null;
  if (available.includes(name)) return name;
  // Allow `bootstrap-guard` for `bootstrap-guard.ts` when it's unambiguous.
  const matches = available.filter(
    (file) => file.slice(0, file.length - extname(file).length) === name,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function formatList(
  agentId: string,
  modsDirectory: string,
  files: string[],
): string {
  const overrides = new Map(
    readAgentModOverrides(agentId).map((entry) => [entry.file, entry]),
  );
  const lines = [`Agent mods (${modsDirectory})`];
  if (files.length === 0 && overrides.size === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }
  for (const file of files) {
    const override = overrides.get(file);
    if (!override) {
      lines.push(`  enabled   ${file}`);
      continue;
    }
    const by = override.disabledBy ? ` by ${override.disabledBy}` : "";
    const why = override.reason ? `: ${override.reason}` : "";
    lines.push(`  disabled  ${file}  (${override.disabledAt}${by}${why})`);
    overrides.delete(file);
  }
  // Overrides for files that no longer exist stay visible until enabled.
  for (const file of overrides.keys()) {
    lines.push(`  disabled  ${file}  (file not found)`);
  }
  return lines.join("\n");
}

export async function handleModsCommand(
  conversationRuntime: ConversationRuntime,
  args: string | undefined,
  actingUserId: string | null,
): Promise<ModsCommandResult> {
  const agentId = conversationRuntime.agentId;
  if (!agentId) {
    return { output: "/mods needs an agent.", success: false };
  }
  const modsDirectory = resolveListenerAgentModsDirectoryForAgent(agentId);
  if (!modsDirectory) {
    return {
      output:
        "This agent has no MemFS mods directory, so there are no agent mods to manage.",
      success: false,
    };
  }

  const [subcommand = "list", target, ...rest] = (args ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const files = listAgentModFiles(modsDirectory);

  if (subcommand === "list") {
    return { output: formatList(agentId, modsDirectory, files), success: true };
  }

  if (subcommand !== "disable" && subcommand !== "enable") {
    return { output: USAGE, success: false };
  }
  if (!target) {
    return { output: USAGE, success: false };
  }

  if (subcommand === "disable") {
    const file = resolveModFileName(target, files);
    if (!file) {
      return {
        output: `No agent mod named ${target}. ${formatList(agentId, modsDirectory, files)}`,
        success: false,
      };
    }
    disableAgentMod(agentId, file, {
      disabledBy: actingUserId,
      reason: rest.length > 0 ? rest.join(" ") : null,
    });
    await reloadListenerModAdapter(conversationRuntime.listener, agentId);
    return {
      output: `Disabled ${file} for this agent. Its file is unchanged; run /mods enable ${file} to turn it back on.`,
      success: true,
    };
  }

  const overridden = readAgentModOverrides(agentId).map((entry) => entry.file);
  const file = resolveModFileName(target, [
    ...new Set([...files, ...overridden]),
  ]);
  if (!file || !enableAgentMod(agentId, file)) {
    return { output: `${target} is not disabled.`, success: false };
  }
  await reloadListenerModAdapter(conversationRuntime.listener, agentId);
  return { output: `Enabled ${file} for this agent.`, success: true };
}
