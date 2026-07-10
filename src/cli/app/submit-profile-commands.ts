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

    if (!argsStr) {
      openOverlay(
        "pin",
        "/pin",
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
      await handlePin(profileCtx, msg, argsStr);
    } finally {
      setActiveProfileCommandId(null);
    }
    return { submitted: true };
  }

  if (trimmed === "/unpin" || trimmed.startsWith("/unpin ")) {
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
      await handleUnpin(profileCtx, msg, argsStr);
    } finally {
      setActiveProfileCommandId(null);
    }
    return { submitted: true };
  }

  return null;
}
