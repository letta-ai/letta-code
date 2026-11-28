import type { MessageContentItem } from "@letta-ai/letta-agent-sdk";
import { useApp } from "ink";
import { useMemo } from "react";
import { Input } from "@/cli/components/InputRich";
import {
  buildMessageContentFromDisplay,
  resolvePlaceholders,
} from "@/cli/helpers/paste-registry";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { buildModInvocationContext } from "@/mods/context";
import { terminalCommands } from "./terminal-commands";
import type { TerminalSession } from "./terminal-session";

const adapter = {
  isLoading: false,
  hadModPanels: false,
  hasModSources: false,
};
export function TerminalComposer({
  store,
  active,
}: {
  store: TerminalSession;
  active: boolean;
}) {
  const { exit } = useApp();
  const state = store.snapshot();
  const width = useTerminalWidth();
  const completions = useMemo(
    () => ({
      commands: terminalCommands,
      searchFiles: (query: string) => store.searchFiles(query),
    }),
    [store],
  );
  const context = useMemo(
    () =>
      buildModInvocationContext({
        workingDirectory: state.device?.workingDirectory ?? "",
        agent: { id: state.agentId, name: state.agentName },
        modelIdentifier: state.model,
        permissionMode: state.device?.permissionMode,
      }),
    [state.device, state.model, state.agentId, state.agentName],
  );
  return (
    <Input
      visible={active}
      inputEnabled={active}
      streaming={state.activity?.startsWith("Working") ?? false}
      tokenCount={state.tokens ?? 0}
      thinkingMessage="Working"
      terminalWidth={width}
      currentModel={state.model}
      modContext={context}
      modAdapter={adapter}
      sessionCompletions={completions}
      permissionMode={state.device?.permissionMode ?? "standard"}
      onPermissionModeChange={(mode) => void store.setPermissionMode(mode)}
      onInterrupt={() => void store.interrupt()}
      onExit={exit}
      onSubmit={async (value) => {
        const text = resolvePlaceholders(value ?? "").trimEnd();
        if (!text) return { submitted: false };
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
      }}
    />
  );
}
