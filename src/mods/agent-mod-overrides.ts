import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Per-agent mod disable overrides for the listener runtime.
 *
 * Stored outside the agent's git-backed MemFS so disabling a mod never edits
 * the mod's source or history, and outside any one conversation so it applies
 * to every turn for that agent on this runtime. Each entry records who changed
 * it and when, so the override is visible and auditable via `/mods list`.
 */

export interface AgentModOverrideEntry {
  /** Mod file name relative to the agent's mods directory. */
  file: string;
  disabledAt: string;
  disabledBy: string | null;
  reason: string | null;
}

interface AgentModOverridesFile {
  agentId: string;
  disabled: AgentModOverrideEntry[];
}

let overridesRootOverride: string | null = null;

function getOverridesRoot(): string {
  return (
    overridesRootOverride ??
    path.join(homedir(), ".letta", "mod-overrides", "agents")
  );
}

function getOverridesPath(agentId: string): string {
  const key = createHash("sha256").update(agentId).digest("hex");
  return path.join(getOverridesRoot(), `${key}.json`);
}

function isEntry(value: unknown): value is AgentModOverrideEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.file === "string" && typeof entry.disabledAt === "string";
}

export function readAgentModOverrides(
  agentId: string,
): AgentModOverrideEntry[] {
  const filePath = getOverridesPath(agentId);
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return [];
    const disabled = (parsed as Partial<AgentModOverridesFile>).disabled;
    return Array.isArray(disabled) ? disabled.filter(isEntry) : [];
  } catch {
    return [];
  }
}

function writeAgentModOverrides(
  agentId: string,
  disabled: AgentModOverrideEntry[],
): void {
  const filePath = getOverridesPath(agentId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const payload: AgentModOverridesFile = { agentId, disabled };
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tempPath, filePath);
}

export function getDisabledAgentModFiles(agentId: string): Set<string> {
  return new Set(readAgentModOverrides(agentId).map((entry) => entry.file));
}

export function disableAgentMod(
  agentId: string,
  file: string,
  details: { disabledBy: string | null; reason: string | null },
): AgentModOverrideEntry {
  const existing = readAgentModOverrides(agentId).filter(
    (entry) => entry.file !== file,
  );
  const entry: AgentModOverrideEntry = {
    file,
    disabledAt: new Date().toISOString(),
    disabledBy: details.disabledBy,
    reason: details.reason,
  };
  writeAgentModOverrides(agentId, [...existing, entry]);
  return entry;
}

/** Returns false when the mod was not disabled. */
export function enableAgentMod(agentId: string, file: string): boolean {
  const existing = readAgentModOverrides(agentId);
  const remaining = existing.filter((entry) => entry.file !== file);
  if (remaining.length === existing.length) return false;
  writeAgentModOverrides(agentId, remaining);
  return true;
}

export const __agentModOverridesTestUtils = {
  setRootForTests(root: string | null): void {
    overridesRootOverride = root;
  },
};
