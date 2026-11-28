import type { MessageContentItem } from "@letta-ai/letta-agent-sdk";
import { useApp } from "ink";
import { useMemo } from "react";
import type { Input } from "@/cli/components/InputRich";
import {
  buildMessageContentFromDisplay,
  resolvePlaceholders,
} from "@/cli/helpers/paste-registry";
import { getRandomThinkingVerb } from "@/cli/helpers/thinking-messages";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { buildModInvocationContext } from "@/mods/context";
import { sessionCommands } from "./terminal-commands";
import type { TerminalSession } from "./terminal-session";

const adapter = {
  isLoading: false,
  hadModPanels: false,
  hasModSources: false,
};
export function useTerminalInput({
  store,
  active,
  initialName,
}: {
  store: TerminalSession;
  active: boolean;
  initialName?: string;
}) {
  const { exit } = useApp();
  const state = store.snapshot();
  const stopping =
    state.activity === "Interrupted" ||
    state.activity === "Interrupt requested";
  const streaming = !stopping && state.turnActive;
  const thinkingMessage = useMemo(
    () => (streaming ? getRandomThinkingVerb() : ""),
    [streaming],
  );
  const messageQueue = useMemo(
    () =>
      state.queue
        .filter((item) => item.source === "user")
        .map(({ content, id }) => ({
          kind: "user" as const,
          queueItemId: id,
          paused: state.pausedQueueIds?.includes(id),
          text:
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .map((part) =>
                      part?.type === "text" ? part.text : "[Attachment]",
                    )
                    .join(" ")
                : "[Message]",
        })),
    [state.queue, state.pausedQueueIds],
  );
  const width = useTerminalWidth();
  const completions = useMemo(
    () => ({
      commands: sessionCommands(state.device?.raw),
      searchFiles: (query: string) => store.searchFiles(query),
    }),
    [store, state.device],
  );
  const modelDisplayName = store.modelDisplayName;
  const context = useMemo(
    () =>
      buildModInvocationContext({
        workingDirectory: state.device?.workingDirectory ?? "",
        agent: { id: state.agentId, name: state.agentName },
        modelIdentifier: state.model,
        modelDisplayName,
        permissionMode: state.device?.permissionMode,
      }),
    [
      state.device,
      state.model,
      state.agentId,
      state.agentName,
      modelDisplayName,
    ],
  );
  return {
    recallQueued: store.queuedInput ? () => store.recallQueued() : undefined,
    visible: active,
    showInspirationalPromptHints:
      active && !streaming && !state.rows.length && !messageQueue.length,
    inputEnabled: active,
    streaming,
    interruptRequested: state.activity === "Interrupt requested",
    agentName: state.agentName ?? initialName,
    agentId: state.agentId,
    messageQueue,
    tokenCount: state.turnBytes,
    networkPhase: streaming ? (state.turnBytes ? "download" : "upload") : null,
    thinkingMessage,
    terminalWidth: width,
    currentModel: modelDisplayName,
    includeSystemPromptUpgradeTip: false,
    modContext: context,
    modAdapter: adapter,
    sessionCompletions: completions,
    permissionMode: state.device?.permissionMode ?? "standard",
    onPermissionModeChange: (mode) => void store.setPermissionMode(mode),
    onInterrupt: () => void store.interrupt(),
    onExit: exit,
    onSubmit: async (value) => {
      const text = resolvePlaceholders(value ?? "").trimEnd();
      if (!text) {
        if (messageQueue.some((item) => item.paused)) {
          await store.send("/queue resume");
          return { submitted: true };
        }
        return { submitted: false };
      }
      if (text === "/exit") exit();
      else {
        const parts: MessageContentItem[] = buildMessageContentFromDisplay(
          value ?? "",
        ).map((part) => {
          if (part.type === "text") return part;
          const { media_type, data } = part.source;
          if (
            media_type !== "image/jpeg" &&
            media_type !== "image/png" &&
            media_type !== "image/webp" &&
            media_type !== "image/gif"
          )
            throw new Error("Unsupported image type");
          return {
            type: "image",
            source: { type: "base64", media_type, data },
          };
        });
        await store.send(
          text,
          parts.some((part) => part.type === "image") ? parts : undefined,
        );
      }
      return { submitted: true };
    },
  } satisfies React.ComponentProps<typeof Input>;
}
