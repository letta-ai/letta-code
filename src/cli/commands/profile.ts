// src/cli/commands/profile.ts
// Profile command handlers for managing local agent profiles

import { getClient } from "../../agent/client";
import { settingsManager } from "../../settings-manager";
import type { Buffers, Line } from "../helpers/accumulator";
import { formatErrorDetails } from "../helpers/errorFormatter";

// tiny helper for unique ids
function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Helper type for command result
type CommandLine = Extract<Line, { kind: "command" }>;

// Context passed to profile handlers
export interface ProfileCommandContext {
  buffersRef: { current: Buffers };
  refreshDerived: () => void;
  agentId: string;
  setCommandRunning: (running: boolean) => void;
  setAgentName: (name: string) => void;
}

// Helper to add a command result to buffers
export function addCommandResult(
  buffersRef: { current: Buffers },
  refreshDerived: () => void,
  input: string,
  output: string,
  success: boolean,
  phase: "running" | "finished" = "finished",
): string {
  const cmdId = uid("cmd");
  const line: CommandLine = {
    kind: "command",
    id: cmdId,
    input,
    output,
    phase,
    ...(phase === "finished" && { success }),
  };
  buffersRef.current.byId.set(cmdId, line);
  buffersRef.current.order.push(cmdId);
  refreshDerived();
  return cmdId;
}

// Helper to update an existing command result
export function updateCommandResult(
  buffersRef: { current: Buffers },
  refreshDerived: () => void,
  cmdId: string,
  input: string,
  output: string,
  success: boolean,
  phase: "running" | "finished" = "finished",
): void {
  const line: CommandLine = {
    kind: "command",
    id: cmdId,
    input,
    output,
    phase,
    ...(phase === "finished" && { success }),
  };
  buffersRef.current.byId.set(cmdId, line);
  refreshDerived();
}

// Get all profiles (merged from global + local, local takes precedence)
export function getProfiles(): Record<string, string> {
  const merged = settingsManager.getMergedProfiles();
  // Convert array format back to Record
  const result: Record<string, string> = {};
  for (const profile of merged) {
    result[profile.name] = profile.agentId;
  }
  return result;
}

// Check if a profile exists, returns error message if not found
export function validateProfileExists(
  profileName: string,
  profiles: Record<string, string>,
): string | null {
  if (!profiles[profileName]) {
    return `Profile "${profileName}" not found. Use /profile to list available profiles.`;
  }
  return null;
}

// Check if a profile name was provided, returns error message if not
export function validateProfileNameProvided(
  profileName: string,
  action: string,
): string | null {
  if (!profileName) {
    return `Please provide a profile name: /profile ${action} <name>`;
  }
  return null;
}

// /profile - list all profiles
export function handleProfileList(
  ctx: ProfileCommandContext,
  msg: string,
): void {
  const profiles = getProfiles();
  const profileNames = Object.keys(profiles);

  let output: string;
  if (profileNames.length === 0) {
    output =
      "No profiles saved. Use /profile save <name> to save the current agent.";
  } else {
    const lines = ["Saved profiles:"];
    for (const name of profileNames.sort()) {
      const profileAgentId = profiles[name];
      const isCurrent = profileAgentId === ctx.agentId;
      lines.push(
        `  ${name} -> ${profileAgentId}${isCurrent ? " (current)" : ""}`,
      );
    }
    output = lines.join("\n");
  }

  addCommandResult(ctx.buffersRef, ctx.refreshDerived, msg, output, true);
}

// /profile save <name>
export async function handleProfileSave(
  ctx: ProfileCommandContext,
  msg: string,
  profileName: string,
): Promise<void> {
  const validationError = validateProfileNameProvided(profileName, "save");
  if (validationError) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      validationError,
      false,
    );
    return;
  }

  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    `Saving profile "${profileName}"...`,
    false,
    "running",
  );

  ctx.setCommandRunning(true);

  try {
    const client = await getClient();
    // Update agent name via API
    await client.agents.update(ctx.agentId, { name: profileName });
    ctx.setAgentName(profileName);

    // Save profile to BOTH local and global settings
    settingsManager.saveProfile(profileName, ctx.agentId);

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Saved profile "${profileName}" (pinned to project + available globally)`,
      true,
    );
  } catch (error) {
    const errorDetails = formatErrorDetails(error, ctx.agentId);
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Failed: ${errorDetails}`,
      false,
    );
  } finally {
    ctx.setCommandRunning(false);
  }
}

// Result from profile load validation
export interface ProfileLoadValidation {
  targetAgentId: string | null;
  needsConfirmation: boolean;
  errorMessage: string | null;
}

// /profile load <name> - validation step (returns whether confirmation is needed)
export function validateProfileLoad(
  ctx: ProfileCommandContext,
  msg: string,
  profileName: string,
): ProfileLoadValidation {
  const nameError = validateProfileNameProvided(profileName, "load");
  if (nameError) {
    addCommandResult(ctx.buffersRef, ctx.refreshDerived, msg, nameError, false);
    return {
      targetAgentId: null,
      needsConfirmation: false,
      errorMessage: nameError,
    };
  }

  const profiles = getProfiles();
  const existsError = validateProfileExists(profileName, profiles);
  if (existsError) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      existsError,
      false,
    );
    return {
      targetAgentId: null,
      needsConfirmation: false,
      errorMessage: existsError,
    };
  }

  // We know the profile exists since validateProfileExists passed
  const targetAgentId = profiles[profileName] as string;

  // Check if current agent is saved to any profile
  const currentAgentSaved = Object.values(profiles).includes(ctx.agentId);

  if (!currentAgentSaved) {
    return { targetAgentId, needsConfirmation: true, errorMessage: null };
  }

  return { targetAgentId, needsConfirmation: false, errorMessage: null };
}

// /profile delete <name>
export function handleProfileDelete(
  ctx: ProfileCommandContext,
  msg: string,
  profileName: string,
): void {
  const nameError = validateProfileNameProvided(profileName, "delete");
  if (nameError) {
    addCommandResult(ctx.buffersRef, ctx.refreshDerived, msg, nameError, false);
    return;
  }

  const profiles = getProfiles();
  const existsError = validateProfileExists(profileName, profiles);
  if (existsError) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      existsError,
      false,
    );
    return;
  }

  const { [profileName]: _, ...remainingProfiles } = profiles;
  settingsManager.updateLocalProjectSettings({
    profiles: remainingProfiles,
  });

  addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    `Deleted profile "${profileName}"`,
    true,
  );
}

// Show usage help for unknown subcommand
export function handleProfileUsage(
  ctx: ProfileCommandContext,
  msg: string,
): void {
  addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    "Usage: /profile [save|load|delete] <name>\n  /profile - list profiles\n  /profile save <name> - save current agent\n  /profile load <name> - load a profile\n  /profile delete <name> - delete a profile",
    false,
  );
}

// /pin [name] - Pin the current agent to this project
// If name is provided and agent isn't a profile yet, creates the profile first
export async function handlePinProfile(
  ctx: ProfileCommandContext,
  msg: string,
  nameArg?: string,
): Promise<void> {
  // Check if current agent is already a profile (has a name in any profile)
  const globalProfiles = settingsManager.getGlobalProfiles();
  const localProfiles = settingsManager.getLocalProfiles();

  // Find profile name for current agent
  let profileName: string | null = null;
  for (const [name, agentId] of Object.entries(globalProfiles)) {
    if (agentId === ctx.agentId) {
      profileName = name;
      break;
    }
  }

  // Check if already pinned locally
  const isAlreadyPinned = Object.values(localProfiles).includes(ctx.agentId);
  if (isAlreadyPinned) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "This agent is already pinned to this project.",
      false,
    );
    return;
  }

  if (!profileName) {
    // Agent isn't saved as a profile yet
    if (nameArg) {
      // User provided a name - create profile and pin it
      settingsManager.saveProfile(nameArg, ctx.agentId);
      addCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        msg,
        `Created and pinned profile "${nameArg}" to this project.`,
        true,
      );
    } else {
      // No name provided - suggest using /pin <name>
      addCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        msg,
        "This agent isn't saved as a profile yet. Use /pin <name> to create and pin it.",
        false,
      );
    }
    return;
  }

  // Pin the existing profile
  settingsManager.pinProfile(profileName, ctx.agentId);
  addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    `Pinned profile "${profileName}" to this project.`,
    true,
  );
}

// /unpin - Unpin the current agent from this project
export function handleUnpinProfile(
  ctx: ProfileCommandContext,
  msg: string,
): void {
  const localProfiles = settingsManager.getLocalProfiles();

  // Find profile name for current agent in local profiles
  let profileName: string | null = null;
  for (const [name, agentId] of Object.entries(localProfiles)) {
    if (agentId === ctx.agentId) {
      profileName = name;
      break;
    }
  }

  if (!profileName) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "This agent isn't pinned to this project.",
      false,
    );
    return;
  }

  // Unpin the profile
  settingsManager.unpinProfile(profileName);
  addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    `Unpinned profile "${profileName}" from this project.`,
    true,
  );
}
