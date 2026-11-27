import { Box, Static, useApp } from "ink";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type AskUserQuestionReceipt,
  parseAskUserQuestionNotif,
  parseAskUserQuestionReceipt,
  prepareAskUserQuestionNotif,
} from "@/ask-user-question";
import { CLEAR_SCREEN_AND_HOME } from "@/cli/app/constants";
import { AgentSelector } from "@/cli/components/AgentSelector";
import { ApprovalSwitch } from "@/cli/components/ApprovalSwitch";
import { AssistantMessage } from "@/cli/components/AssistantMessageRich";
import { CommandMessage } from "@/cli/components/CommandMessage";
import { ConversationSelector } from "@/cli/components/ConversationSelector";
import { ErrorMessage } from "@/cli/components/ErrorMessageRich";
import { HelpDialog } from "@/cli/components/HelpDialog";
import { InlineQuestionApproval } from "@/cli/components/InlineQuestionApproval";
import { Input } from "@/cli/components/InputRich";
import { LettaLoginOverlay } from "@/cli/components/LettaLoginOverlay";
import { McpSelector } from "@/cli/components/McpSelector";
import { MemfsRequiredNotice } from "@/cli/components/MemfsRequiredNotice";
import {
  MemfsTreeViewer,
  type MemfsViewerSource,
} from "@/cli/components/MemfsTreeViewer";
import { ModelSelector } from "@/cli/components/ModelSelector";
import { ProviderSelector } from "@/cli/components/ProviderSelector";
import { ReasoningMessage } from "@/cli/components/ReasoningMessageRich";
import { SkillsDialog } from "@/cli/components/SkillsDialog";
import { StatusMessage } from "@/cli/components/StatusMessage";
import { SubagentGroupDisplay } from "@/cli/components/SubagentGroupDisplay";
import { Text } from "@/cli/components/Text";
import { ToolCallMessage } from "@/cli/components/ToolCallMessageRich";
import { UserMessage } from "@/cli/components/UserMessageRich";
import { AnimationProvider } from "@/cli/contexts/AnimationContext";
import { buildCliModContext } from "@/cli/helpers/cli-mod-context";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { useLocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import type { PermissionMode } from "@/permissions/mode";
import type { QueuedMessage } from "@/utils/message-queue-bridge";
import {
  type CommandContext,
  createConversation,
  routeCommand,
  type SessionTarget,
  type TuiOverlay,
} from "./command-router";
import { loadMemorySource } from "./memory-source";
import type { TuiItem } from "./project-rows";
import { fileEditHeader, serverDiffFromPreviews } from "./server-diff";
import type {
  TuiApproval,
  TuiSessionStore,
  TuiSnapshot,
} from "./session-store";

type InkApp = ReturnType<typeof useApp> & { resetStaticOutput?: () => void };

export interface TuiRootProps {
  store: TuiSessionStore;
  agentId: string;
  agentName: string | null;
  conversationId: string;
  hostLabel: string;
  switchSession: (target: SessionTarget) => void;
  renameAgent: (name: string) => void;
  services: Pick<CommandContext, "logout" | "usage" | "context">;
  isLocalBackend: boolean;
}

function TranscriptItem({ item }: { item: TuiItem }) {
  switch (item.kind) {
    case "user":
      return <UserMessage line={item} prompt={CLI_GLYPHS.prompt} />;
    case "assistant":
      return <AssistantMessage line={item} />;
    case "reasoning":
      return <ReasoningMessage line={item} />;
    case "tool_call":
      return (
        <ToolCallMessage line={item} isStreaming={item.phase !== "finished"} />
      );
    case "command":
      return <CommandMessage line={item} />;
    case "error":
      return <ErrorMessage line={item} />;
    default:
      return <StatusMessage line={item} />;
  }
}

type StaticEntry = { kind: "header"; id: string } | TuiItem;

function pendingQuestion(
  items: readonly TuiItem[],
  dismissed: ReadonlySet<string>,
): AskUserQuestionReceipt | null {
  const answered = new Set(dismissed);
  for (const item of items) {
    if (item.kind !== "user") continue;
    for (const response of parseAskUserQuestionNotif(item.text)) {
      answered.add(response.toolCallId);
    }
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || item.kind !== "tool_call" || !item.resultText) continue;
    const receipt = parseAskUserQuestionReceipt(item.resultText);
    if (receipt && !answered.has(receipt.toolCallId)) return receipt;
  }
  return null;
}

function ApprovalView({
  approval,
  store,
}: {
  approval: TuiApproval;
  store: TuiSessionStore;
}) {
  const serverDiff = useMemo(
    () => serverDiffFromPreviews(approval.diffs),
    [approval.diffs],
  );
  return (
    <ApprovalSwitch
      approval={approval}
      precomputedDiff={serverDiff?.diff}
      fileEditHeader={fileEditHeader(
        approval.toolName,
        approval.toolInput,
        serverDiff,
      )}
      allowPersistence={approval.permissionSuggestions.length > 0}
      approveAlwaysText={approval.permissionSuggestions[0]?.text}
      onApprove={() =>
        store.resolveApproval(approval.requestId, { kind: "allow" })
      }
      onApproveAlways={() =>
        store.resolveApproval(approval.requestId, { kind: "allow_always" })
      }
      onDeny={(reason) =>
        store.resolveApproval(approval.requestId, { kind: "deny", reason })
      }
      onCancel={() => void store.interrupt()}
    />
  );
}

function thinkingLabel(snapshot: TuiSnapshot): string {
  if (snapshot.run === "interrupting") return "Interrupting";
  if (snapshot.run === "awaiting_approval") return "Waiting for approval";
  return "Working";
}

export function TuiRoot({
  store,
  agentId,
  agentName,
  conversationId,
  hostLabel,
  switchSession,
  renameAgent,
  services,
  isLocalBackend,
}: TuiRootProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const columns = useTerminalWidth();
  const { exit, resetStaticOutput } = useApp() as InkApp;
  const [overlay, setOverlay] = useState<TuiOverlay | null>(null);
  const [memory, setMemory] = useState<
    MemfsViewerSource | "loading" | "unavailable" | null
  >(null);
  const [dismissedQuestions, setDismissedQuestions] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [paintedEpoch, setPaintedEpoch] = useState(snapshot.epoch);

  useEffect(() => {
    if (paintedEpoch === snapshot.epoch) return;
    process.stdout.write(CLEAR_SCREEN_AND_HOME);
    resetStaticOutput?.();
    setPaintedEpoch(snapshot.epoch);
  }, [paintedEpoch, snapshot.epoch, resetStaticOutput]);

  const committed = useMemo<StaticEntry[]>(
    () => [
      { kind: "header", id: "header" },
      ...snapshot.items.slice(0, snapshot.committedCount),
    ],
    [snapshot.items, snapshot.committedCount],
  );
  const live = snapshot.items.slice(snapshot.committedCount);
  const approval = snapshot.approvals[0];
  const question = useMemo(
    () =>
      snapshot.run === "idle"
        ? pendingQuestion(snapshot.items, dismissedQuestions)
        : null,
    [snapshot.items, snapshot.run, dismissedQuestions],
  );
  const model = snapshot.session?.model ?? null;
  const permissionMode = snapshot.device?.permissionMode;
  const busy = snapshot.run !== "idle";

  const closeOverlay = useCallback(() => setOverlay(null), []);
  const handleExit = useCallback(() => {
    store.close();
    exit();
  }, [store, exit]);

  const openOverlay = useCallback(
    (next: TuiOverlay) => {
      setOverlay(next);
      if (next !== "memory") return;
      setMemory("loading");
      loadMemorySource(store, agentId)
        .then((source) => setMemory(source ?? "unavailable"))
        .catch((error: unknown) => {
          setOverlay(null);
          store.note([
            `Unable to load memory: ${error instanceof Error ? error.message : String(error)}`,
          ]);
        });
    },
    [store, agentId],
  );

  const commandContext = useMemo<CommandContext>(
    () => ({
      store,
      agentId,
      conversationId,
      openOverlay,
      switchSession,
      renameAgent,
      exit: handleExit,
      ...services,
    }),
    [
      store,
      agentId,
      conversationId,
      openOverlay,
      switchSession,
      renameAgent,
      handleExit,
      services,
    ],
  );

  const handleSubmit = useCallback(
    async (message?: string) => {
      const text = message?.trim();
      if (!text) return { submitted: false };
      if (text.startsWith("/")) void routeCommand(commandContext, text);
      else void store.send(text);
      return { submitted: true };
    },
    [store, commandContext],
  );

  const queueRef = useRef(snapshot.queue);
  queueRef.current = snapshot.queue;
  const handleQueueEdit = useCallback(() => {
    const text = queueRef.current.map((item) => item.text).join("\n");
    void store.takeQueue();
    return text;
  }, [store]);
  const messageQueue = useMemo<QueuedMessage[]>(
    () => snapshot.queue.map((item) => ({ kind: "user", text: item.text })),
    [snapshot.queue],
  );

  const handlePermissionModeChange = useCallback(
    (mode: PermissionMode) => {
      void store.setPermissionMode(mode).catch((error: unknown) => {
        store.note([
          `Unable to change permission mode: ${error instanceof Error ? error.message : String(error)}`,
        ]);
      });
    },
    [store],
  );

  const answerQuestion = useCallback(
    (
      receipt: AskUserQuestionReceipt,
      answers: Record<string, string> | null,
    ) => {
      setDismissedQuestions((previous) =>
        new Set(previous).add(receipt.toolCallId),
      );
      void store.send(
        prepareAskUserQuestionNotif({
          type: "ask_user_question_response",
          version: 2,
          toolCallId: receipt.toolCallId,
          questions: receipt.questions,
          ...(answers
            ? { status: "answered", answers }
            : { status: "dismissed" }),
        }),
      );
    },
    [store],
  );

  const startNewConversation = useCallback(() => {
    setOverlay(null);
    createConversation({ store, agentId })
      .then((created) => switchSession({ agentId, conversationId: created }))
      .catch((error: unknown) => {
        store.note([error instanceof Error ? error.message : String(error)]);
      });
  }, [store, agentId, switchSession]);

  const modContext = buildCliModContext({
    modelId: model,
    modelDisplayName: model,
    modelProvider: model?.split("/")[0] ?? null,
    currentDirectory: snapshot.device?.cwd ?? process.cwd(),
    projectDirectory: snapshot.device?.cwd ?? process.cwd(),
    sessionId: conversationId,
    agentId,
    agentName,
    memfsEnabled: Boolean(snapshot.device?.memoryDirectory),
    memfsDirectory: snapshot.device?.memoryDirectory ?? null,
    permissionMode: permissionMode ?? "standard",
    networkPhase: null,
    terminalWidth: columns,
    backgroundAgents: [],
  });
  const modAdapter = useLocalModAdapter(modContext, { disabled: true });

  const footerNotification =
    [
      snapshot.connection !== "connected" ? snapshot.connection : null,
      hostLabel,
      snapshot.backgroundProcessCount > 0
        ? `${snapshot.backgroundProcessCount} background`
        : null,
      snapshot.hasOlder ? "older history: /history" : null,
    ]
      .filter(Boolean)
      .join(" · ") || null;

  const inputEnabled =
    !overlay && !approval && !question && snapshot.connection !== "closed";

  return (
    <Box flexDirection="column">
      <Static
        key={paintedEpoch}
        items={committed}
        style={{ flexDirection: "column" }}
      >
        {(entry: StaticEntry, index: number) =>
          entry.kind === "header" ? (
            <Box key={entry.id} flexDirection="column">
              <Text bold>{`Letta Code · ${agentName ?? agentId}`}</Text>
              <Text dimColor>{`${agentId} · ${conversationId}`}</Text>
            </Box>
          ) : (
            <Box key={entry.id} marginTop={index > 0 ? 1 : 0}>
              <TranscriptItem item={entry} />
            </Box>
          )
        }
      </Static>
      <AnimationProvider shouldAnimate={true}>
        {live.map((item) => (
          <Box key={item.id} marginTop={1}>
            <TranscriptItem item={item} />
          </Box>
        ))}
        {approval ? (
          <Box flexDirection="column" marginTop={1}>
            <ApprovalView approval={approval} store={store} />
            {snapshot.approvals.length > 1 ? (
              <Text
                dimColor
              >{`${snapshot.approvals.length - 1} more pending`}</Text>
            ) : null}
          </Box>
        ) : null}
        <SubagentGroupDisplay />
      </AnimationProvider>
      {question && !approval ? (
        <Box marginTop={1} flexDirection="column">
          <InlineQuestionApproval
            key={question.toolCallId}
            questions={question.questions}
            onSubmit={(answers) => answerQuestion(question, answers)}
            onCancel={() => answerQuestion(question, null)}
            isFocused={!overlay}
          />
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Input
          visible={true}
          streaming={busy}
          tokenCount={0}
          thinkingMessage={thinkingLabel(snapshot)}
          onSubmit={handleSubmit}
          inputEnabled={inputEnabled}
          collapseInputWhenDisabled={true}
          permissionMode={permissionMode}
          onPermissionModeChange={handlePermissionModeChange}
          onExit={handleExit}
          onInterrupt={() => void store.interrupt()}
          interruptRequested={snapshot.run === "interrupting"}
          agentId={agentId}
          agentName={agentName}
          currentModel={model}
          currentModelProvider={model?.split("/")[0] ?? null}
          messageQueue={messageQueue}
          onQueueEdit={handleQueueEdit}
          conversationId={conversationId}
          terminalWidth={columns}
          modContext={modContext}
          modAdapter={modAdapter}
          statusLinePrompt={CLI_GLYPHS.prompt}
          footerNotification={footerNotification}
        />
      </Box>
      {overlay === "help" ? <HelpDialog onClose={closeOverlay} /> : null}
      {overlay === "skills" ? (
        <SkillsDialog onClose={closeOverlay} agentId={agentId} />
      ) : null}
      {overlay === "agents" ? (
        <AgentSelector
          currentAgentId={agentId}
          onCancel={closeOverlay}
          onLogin={() => setOverlay("login")}
          onSelect={(selectedAgentId) => {
            setOverlay(null);
            if (selectedAgentId !== agentId) {
              switchSession({
                agentId: selectedAgentId,
                conversationId: "default",
              });
            }
          }}
        />
      ) : null}
      {overlay === "model" ? (
        <ModelSelector
          currentModelHandle={model}
          localModelCatalog={isLocalBackend}
          onCancel={closeOverlay}
          onOpenConnect={() => setOverlay("connect")}
          onOpenLogin={() => setOverlay("login")}
          onSelect={(selection) => {
            setOverlay(null);
            const effort = (
              selection.updateArgs as { reasoning_effort?: unknown } | undefined
            )?.reasoning_effort;
            void store.runLocalCommand("/model", async () => {
              await store.updateModel({
                modelId: selection.id,
                modelHandle: selection.handle,
                ...(typeof effort === "string"
                  ? { reasoningEffort: effort as never }
                  : {}),
              });
              return { output: `Switched to ${selection.label}` };
            });
          }}
        />
      ) : null}
      {overlay === "resume" ? (
        <ConversationSelector
          agentId={agentId}
          agentName={agentName ?? undefined}
          currentConversationId={conversationId}
          onCancel={closeOverlay}
          onNewConversation={startNewConversation}
          onSelect={(selectedConversationId) => {
            setOverlay(null);
            if (selectedConversationId !== conversationId) {
              switchSession({
                agentId,
                conversationId: selectedConversationId,
              });
            }
          }}
        />
      ) : null}
      {overlay === "memory" && memory === "unavailable" ? (
        <MemfsRequiredNotice onClose={closeOverlay} />
      ) : null}
      {overlay === "memory" && memory === "loading" ? (
        <Text dimColor>Loading memory…</Text>
      ) : null}
      {overlay === "memory" && memory && typeof memory === "object" ? (
        <MemfsTreeViewer
          agentId={agentId}
          agentName={agentName ?? undefined}
          conversationId={conversationId}
          onClose={closeOverlay}
          source={memory}
        />
      ) : null}
      {overlay === "login" ? (
        <LettaLoginOverlay
          onCancel={closeOverlay}
          onAlreadyLoggedIn={() => {
            setOverlay(null);
            store.note(["Already logged in."]);
          }}
          onComplete={() => {
            setOverlay(null);
            store.note(["Logged in. Restart to use Cloud agents."]);
          }}
        />
      ) : null}
      {overlay === "connect" ? (
        <ProviderSelector onCancel={closeOverlay} />
      ) : null}
      {overlay === "mcp" ? (
        <McpSelector
          agentId={agentId}
          onCancel={closeOverlay}
          onAdd={() => {
            setOverlay(null);
            store.note([
              "Add a client-local server with `/mcp add --transport <stdio|http|sse> <name> <command|url> ...`.",
            ]);
          }}
        />
      ) : null}
    </Box>
  );
}
