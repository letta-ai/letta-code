import type { Dispatch, SetStateAction } from "react";
import type {
  ActiveOverlay,
  AppCommandRunner,
  QueuedOverlayAction,
} from "./types";

type SubmitCommandResult = { submitted: boolean };

type NavigationCommandContext = {
  commandRunner: AppCommandRunner;
  conversationId: string;
  setQueuedOverlayAction: Dispatch<SetStateAction<QueuedOverlayAction>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  openOverlay: (
    overlay: NonNullable<ActiveOverlay>,
    input: string,
    openingOutput: string,
    dismissOutput: string,
  ) => void;
};

export async function handleNavigationCommand(
  trimmed: string,
  ctx: NavigationCommandContext,
): Promise<SubmitCommandResult | null> {
  const {
    commandRunner,
    conversationId,
    setQueuedOverlayAction,
    setSearchQuery,
    openOverlay,
  } = ctx;

  // Special handling for /agents command - show agent browser
  if (
    trimmed === "/agents" ||
    trimmed === "/pinned" ||
    trimmed === "/profiles"
  ) {
    openOverlay(
      "resume",
      "/agents",
      "Opening agent browser...",
      "Agent browser dismissed",
    );
    return { submitted: true };
  }

  // Special handling for /resume command - show conversation selector or switch directly
  if (trimmed.startsWith("/resume")) {
    const parts = trimmed.split(/\s+/);
    const targetConvId = parts[1];

    if (targetConvId === "help") {
      const cmd = commandRunner.start(trimmed, "Showing resume help...");
      const output = [
        "/resume help",
        "",
        "Resume a previous conversation.",
        "",
        "USAGE",
        "  /resume                       — open conversation selector",
        "  /resume <conversation_id>     — switch directly to a conversation",
        "  /resume help                  — show this help",
      ].join("\n");
      cmd.finish(output, true);
      return { submitted: true };
    }

    if (targetConvId) {
      const cmd = commandRunner.start(trimmed, "Switching conversation...");
      if (targetConvId === conversationId) {
        cmd.finish("Already on this conversation", true);
        return { submitted: true };
      }

      setQueuedOverlayAction({
        type: "switch_conversation",
        conversationId: targetConvId,
        commandId: cmd.id,
      });
      cmd.update({
        output: "Switch queued until accepted messages finish...",
        phase: "running",
      });
      return { submitted: true };
    }

    openOverlay(
      "conversations",
      "/resume",
      "Opening conversation selector...",
      "Conversation selector dismissed",
    );
    return { submitted: true };
  }

  // Special handling for /search command - show message search
  if (trimmed.startsWith("/search")) {
    const [, ...rest] = trimmed.split(/\s+/);
    const query = rest.join(" ").trim();
    setSearchQuery(query);
    openOverlay(
      "search",
      "/search",
      "Opening message search...",
      "Message search dismissed",
    );
    return { submitted: true };
  }

  return null;
}
