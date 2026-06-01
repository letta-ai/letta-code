import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  addCommandResult,
  handlePin,
  handleProfileDelete,
  handleProfileSave,
  handleProfileUsage,
  handleUnpin,
  type ProfileCommandContext,
  setActiveCommandId as setActiveProfileCommandId,
  validateProfileLoad,
} from "@/cli/commands/profile";
import type { Buffers } from "@/cli/helpers/accumulator";
import type { ActiveOverlay, AppCommandRunner } from "./types";

type SubmitCommandResult = { submitted: boolean };

type ProfileConfirmPending = {
  name: string;
  agentId: string;
  cmdId: string;
};

type ProfileCommandRouterContext = {
  agentId: string;
  agentName: string | null;
  buffersRef: MutableRefObject<Buffers>;
  commandRunner: AppCommandRunner;
  handleAgentSelect: (
    targetAgentId: string,
    opts?: {
      profileName?: string;
      conversationId?: string;
      commandId?: string;
    },
  ) => Promise<void>;
  refreshDerived: () => void;
  setCommandRunning: (value: boolean) => void;
  setPinDialogLocal: Dispatch<SetStateAction<boolean>>;
  setProfileConfirmPending: Dispatch<
    SetStateAction<ProfileConfirmPending | null>
  >;
  openOverlay: (
    overlay: NonNullable<ActiveOverlay>,
    input: string,
    openingOutput: string,
    dismissOutput: string,
  ) => void;
  updateAgentName: (name: string) => void;
};

export async function handleProfileCommand(
  msg: string,
  trimmed: string,
  ctx: ProfileCommandRouterContext,
): Promise<SubmitCommandResult | null> {
  const {
    agentId,
    agentName,
    buffersRef,
    commandRunner,
    handleAgentSelect,
    refreshDerived,
    setCommandRunning,
    setPinDialogLocal,
    setProfileConfirmPending,
    openOverlay,
    updateAgentName,
  } = ctx;

  // Special handling for /profile command - manage local profiles
  if (trimmed.startsWith("/profile")) {
    const parts = trimmed.split(/\s+/);
    const subcommand = parts[1]?.toLowerCase();
    const profileName = parts.slice(2).join(" ");

    const profileCtx: ProfileCommandContext = {
      buffersRef,
      refreshDerived,
      agentId,
      agentName: agentName || "",
      setCommandRunning,
      updateAgentName,
    };

    if (!subcommand) {
      openOverlay(
        "resume",
        "/profile",
        "Opening agent browser...",
        "Agent browser dismissed",
      );
      return { submitted: true };
    }

    const cmd = commandRunner.start(trimmed, "Running profile command...");
    setActiveProfileCommandId(cmd.id);
    const clearProfileCommandId = () => setActiveProfileCommandId(null);

    if (subcommand === "save") {
      await handleProfileSave(profileCtx, msg, profileName);
      clearProfileCommandId();
      return { submitted: true };
    }

    if (subcommand === "load") {
      const validation = validateProfileLoad(profileCtx, msg, profileName);
      if (validation.errorMessage) {
        clearProfileCommandId();
        return { submitted: true };
      }

      if (validation.needsConfirmation && validation.targetAgentId) {
        const cmdId = addCommandResult(
          buffersRef,
          refreshDerived,
          msg,
          "Warning: Current agent is not saved to any profile.\nPress Enter to continue, or type anything to cancel.",
          false,
          "running",
        );
        setProfileConfirmPending({
          name: profileName,
          agentId: validation.targetAgentId,
          cmdId,
        });
        clearProfileCommandId();
        return { submitted: true };
      }

      if (validation.targetAgentId) {
        await handleAgentSelect(validation.targetAgentId, {
          profileName,
          commandId: cmd.id,
        });
      }
      clearProfileCommandId();
      return { submitted: true };
    }

    if (subcommand === "delete") {
      handleProfileDelete(profileCtx, msg, profileName);
      clearProfileCommandId();
      return { submitted: true };
    }

    handleProfileUsage(profileCtx, msg);
    clearProfileCommandId();
    return { submitted: true };
  }

  if (trimmed === "/pin" || trimmed.startsWith("/pin ")) {
    const argsStr = trimmed.slice(4).trim();
    const parts = argsStr.split(/\s+/).filter(Boolean);
    const target = parts[0]?.toLowerCase();

    if (target === "help") {
      const cmd = commandRunner.start(trimmed, "Showing pin help...");
      const output = [
        "/pin help",
        "",
        "Pin agents and conversations.",
        "",
        "USAGE",
        "  /pin [name]        — pin the current agent globally",
        "  /pin -l [name]     — pin the current agent to this project",
        "  /pin agent [name]  — pin the current agent",
        "  /pin convo         — manage pinned conversations",
        "  /pin agents        — manage pinned agents",
        "  /pin help          — show this help",
      ].join("\n");
      cmd.finish(output, true);
      return { submitted: true };
    }

    if (target === "convo" || target === "conversation") {
      openOverlay(
        "pin-conversations",
        "/pin convo",
        "Opening conversation pin manager...",
        "Conversation pin manager dismissed",
      );
      return { submitted: true };
    }

    if (target === "agents") {
      openOverlay(
        "pin-agents",
        "/pin agents",
        "Opening agent pin manager...",
        "Agent pin manager dismissed",
      );
      return { submitted: true };
    }

    const currentArgs = target === "agent" ? parts.slice(1).join(" ") : argsStr;
    const currentParts = currentArgs.split(/\s+/).filter(Boolean);
    let hasNameArg = false;
    let isLocal = false;

    for (const part of currentParts) {
      if (part === "-l" || part === "--local") {
        isLocal = true;
      } else {
        hasNameArg = true;
      }
    }

    if (!hasNameArg) {
      setPinDialogLocal(isLocal);
      openOverlay(
        "pin",
        target === "agent" ? "/pin agent" : "/pin",
        "Opening pin dialog...",
        "Pin dialog dismissed",
      );
      return { submitted: true };
    }

    const profileCtx: ProfileCommandContext = {
      buffersRef,
      refreshDerived,
      agentId,
      agentName: agentName || "",
      setCommandRunning,
      updateAgentName,
    };
    const cmd = commandRunner.start(trimmed, "Pinning agent...");
    setActiveProfileCommandId(cmd.id);
    try {
      await handlePin(profileCtx, msg, currentArgs);
    } finally {
      setActiveProfileCommandId(null);
    }
    return { submitted: true };
  }

  if (trimmed === "/unpin" || trimmed.startsWith("/unpin ")) {
    const unpinArgsStr = trimmed.slice(6).trim();

    if (unpinArgsStr === "help") {
      const cmd = commandRunner.start(trimmed, "Showing unpin help...");
      const output = [
        "/unpin help",
        "",
        "Unpin the current agent.",
        "",
        "USAGE",
        "  /unpin       — unpin globally",
        "  /unpin -l    — unpin locally",
        "  /unpin help  — show this help",
      ].join("\n");
      cmd.finish(output, true);
      return { submitted: true };
    }

    const profileCtx: ProfileCommandContext = {
      buffersRef,
      refreshDerived,
      agentId,
      agentName: agentName || "",
      setCommandRunning,
      updateAgentName,
    };
    const argsStr = trimmed.slice(6).trim();
    const cmd = commandRunner.start(trimmed, "Unpinning agent...");
    setActiveProfileCommandId(cmd.id);
    try {
      handleUnpin(profileCtx, msg, argsStr);
    } finally {
      setActiveProfileCommandId(null);
    }
    return { submitted: true };
  }

  return null;
}
