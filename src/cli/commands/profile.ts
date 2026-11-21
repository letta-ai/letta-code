
import {
  pinAgentForCurrentUser,
  unpinAgentForCurrentUser,
} from "@/agent/favorites";
import { getBackend } from "@/backend";
import type { Buffers, Line } from "@/cli/helpers/accumulator";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import { settingsManager } from "@/settings-manager";

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

type CommandLine = Extract<Line, { kind: "command" }>;

let activeCommandId: string | null = null;

export function setActiveCommandId(id: string | null): void {
  activeCommandId = id;
}

export interface ProfileCommandContext {
  buffersRef: { current: Buffers };
  refreshDerived: () => void;
  agentId: string;
  agentName: string;
  setCommandRunning: (running: boolean) => void;
  updateAgentName: (name: string) => void;
}

export function addCommandResult(
  buffersRef: { current: Buffers },
  refreshDerived: () => void,
  input: string,
  output: string,
  success: boolean,
  phase: "running" | "finished" = "finished",
): string {
  const cmdId = activeCommandId ?? uid("cmd");
  const existing = buffersRef.current.byId.get(cmdId);
  const nextInput =
    existing && existing.kind === "command" ? existing.input : input;
  const line: CommandLine = {
    kind: "command",
    id: cmdId,
    input: nextInput,
    output,
    phase,
    ...(phase === "finished" && { success }),
  };
  buffersRef.current.byId.set(cmdId, line);
  if (!buffersRef.current.order.includes(cmdId)) {
    buffersRef.current.order.push(cmdId);
  }
  refreshDerived();
  return cmdId;
}

export function updateCommandResult(
  buffersRef: { current: Buffers },
  refreshDerived: () => void,
  cmdId: string,
  input: string,
  output: string,
  success: boolean,
  phase: "running" | "finished" = "finished",
): void {
  const existing = buffersRef.current.byId.get(cmdId);
  const nextInput =
    existing && existing.kind === "command" ? existing.input : input;
  const line: CommandLine = {
    kind: "command",
    id: cmdId,
    input: nextInput,
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
  const result: Record<string, string> = {};
  for (const profile of merged) {
    result[profile.name] = profile.agentId;
  }
  return result;
}

export function validateProfileExists(
  profileName: string,
  profiles: Record<string, string>,
): string | null {
  if (!profiles[profileName]) {
    return `Profile "${profileName}" not found. Use /profile to list available profiles.`;
  }
  return null;
}

export function validateProfileNameProvided(
  profileName: string,
  action: string,
): string | null {
  if (!profileName) {
    return `Please provide a profile name: /profile ${action} <name>`;
  }
  return null;
}

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
    await getBackend().updateAgent(ctx.agentId, { name: profileName });
    ctx.updateAgentName(profileName);

    await pinAgentForCurrentUser(ctx.agentId);

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Pinned "${profileName}".`,
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

export interface ProfileLoadValidation {
  targetAgentId: string | null;
  needsConfirmation: boolean;
  errorMessage: string | null;
}

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

  const currentAgentSaved = Object.values(profiles).includes(ctx.agentId);

  if (!currentAgentSaved) {
    return { targetAgentId, needsConfirmation: true, errorMessage: null };
  }

  return { targetAgentId, needsConfirmation: false, errorMessage: null };
}

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

export async function handlePin(
  ctx: ProfileCommandContext,
  msg: string,
  argsStr: string,
): Promise<void> {
  const name = argsStr.trim() || undefined;

  if (name && name !== ctx.agentName) {
    try {
      await getBackend().updateAgent(ctx.agentId, { name });
      ctx.updateAgentName(name);
    } catch (error) {
      addCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        msg,
        `Failed to rename agent: ${error}`,
        false,
      );
      return;
    }
  }

  const displayName = name || ctx.agentName || ctx.agentId.slice(0, 12);

  const pinStatus = await pinAgentForCurrentUser(ctx.agentId);

  if (pinStatus === "already-pinned") {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "This agent is already pinned.",
      false,
    );
    return;
  }

  addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    `Pinned "${displayName}".`,
    true,
  );
}

export async function handleUnpin(
  ctx: ProfileCommandContext,
  msg: string,
  argsStr: string,
): Promise<void> {
  if (argsStr.trim()) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Usage: /unpin",
      false,
    );
    return;
  }

  const displayName = ctx.agentName || ctx.agentId.slice(0, 12);
  let unpinStatus: Awaited<ReturnType<typeof unpinAgentForCurrentUser>>;
  try {
    unpinStatus = await unpinAgentForCurrentUser(ctx.agentId);
  } catch (error) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      `Failed to unpin agent: ${error}`,
      false,
    );
    return;
  }

  if (unpinStatus === "not-pinned") {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "This agent isn't pinned.",
      false,
    );
    return;
  }

  addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    `Unpinned "${displayName}".`,
    true,
  );
}
