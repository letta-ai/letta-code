import { Box } from "ink";
import { isLocalAgentId } from "@/agent/agent-id";
import { isAskUserQuestions } from "@/ask-user-question";
import { LettaLoginView } from "@/auth/LettaLoginView";
import { SessionModelPicker } from "@/cli/app/SessionModelPicker";
import { StaticTranscript } from "@/cli/app/StaticTranscript";
import { terminalCommands } from "@/cli/app/terminal-commands";
import type { useSessionView } from "@/cli/app/use-session-view";
import { AgentSelector } from "@/cli/components/AgentSelector";
import { ApprovalSwitch } from "@/cli/components/ApprovalSwitch";
import { AssistantMessage } from "@/cli/components/AssistantMessageRich";
import { BashCommandMessage } from "@/cli/components/BashCommandMessage";
import { CommandMessage } from "@/cli/components/CommandMessage";
import { ConversationSelector } from "@/cli/components/ConversationSelector";
import { ErrorMessage } from "@/cli/components/ErrorMessageRich";
import { EventMessage } from "@/cli/components/EventMessage";
import { HelpDialog } from "@/cli/components/HelpDialog";
import { InlineQuestionApproval } from "@/cli/components/InlineQuestionApproval";
import { Input } from "@/cli/components/InputRich";
import { MemfsTreeViewer } from "@/cli/components/MemfsTreeViewer";
import { PendingApprovalStub } from "@/cli/components/PendingApprovalStub";
import { LiveReasoningMessage } from "@/cli/components/ReasoningMessageRich";
import { SearchablePicker } from "@/cli/components/SearchablePicker";
import { SessionDiff } from "@/cli/components/SessionDiff";
import { StatusMessage } from "@/cli/components/StatusMessage";
import { SubagentGroupDisplay } from "@/cli/components/SubagentGroupDisplay";
import { ToolCallMessage } from "@/cli/components/ToolCallMessageRich";
import { LiveUserMessage as UserMessage } from "@/cli/components/UserMessageRich";
import { WelcomeScreen } from "@/cli/components/WelcomeScreen";
import { AnimationProvider } from "@/cli/contexts/AnimationContext";
import {
  isFileEditTool,
  isFileWriteTool,
  isPatchTool,
  isShellTool,
  isTaskTool,
} from "@/cli/helpers/tool-name-mapping";
import type { DiffPreview } from "@/types/protocol_v2";
export function AppView({
  state,
  store,
  approval,
  fileApproval,
  suggestion,
  columns,
  loadingState,
  sessionWelcome,
  staticItems,
  liveItems,
  precomputedDiffs,
  currentApproval,
  pendingIds,
  streaming,
  statusLinePrompt,
  input,
  active,
}: ReturnType<typeof useSessionView>) {
  const approvalView =
    approval &&
    (approval.name === "AskUserQuestion" &&
    isAskUserQuestions(approval.input.questions) ? (
      <InlineQuestionApproval
        questions={approval.input.questions}
        onSubmit={(answers) =>
          store.decide(approval, {
            behavior: "allow",
            updatedInput: { ...approval.input, answers },
          })
        }
        onCancel={() =>
          store.decide(approval, {
            behavior: "deny",
            message: "Question dismissed",
          })
        }
      />
    ) : (
      <ApprovalSwitch
        approval={{
          toolCallId: approval.context?.toolCallId ?? "",
          toolName: approval.name,
          toolArgs: JSON.stringify(approval.input),
        }}
        sessionPreview={
          fileApproval
            ? (
                (approval.context?.diffs as DiffPreview[] | undefined) ?? []
              ).map((preview, index, all) => (
                <SessionDiff
                  key={`${preview.fileName}-${index}`}
                  preview={preview}
                  showFilename={all.length > 1}
                />
              ))
            : undefined
        }
        workingDirectory={state.device?.workingDirectory ?? "/"}
        allowPersistence={!!suggestion}
        approveAlwaysText={suggestion?.text}
        onApprove={() => store.decide(approval, { behavior: "allow" })}
        onApproveAlways={() =>
          suggestion &&
          store.decide(approval, {
            behavior: "allow",
            updatedPermissions: [suggestion.id],
          })
        }
        onDeny={(message) =>
          store.decide(approval, { behavior: "deny", message })
        }
        onCancel={() =>
          store.decide(approval, {
            behavior: "deny",
            message: "Denied by user",
          })
        }
      />
    ));
  return (
    <Box key={state.epoch} flexDirection="column">
      <StaticTranscript
        renderEpoch={state.epoch}
        items={staticItems}
        columns={columns}
        statusLinePrompt={statusLinePrompt}
        showCompactionsEnabled={true}
        precomputedDiffs={precomputedDiffs}
      />

      <Box flexDirection="column">
        {loadingState !== "ready" && (
          <WelcomeScreen loadingState={loadingState} session={sessionWelcome} />
        )}

        {loadingState === "ready" && (
          <>
            <AnimationProvider shouldAnimate={true}>
              {liveItems.length > 0 && (
                <Box flexDirection="column">
                  {liveItems.map((ln) => {
                    const isFileTool =
                      ln.kind === "tool_call" &&
                      ln.name &&
                      (isFileEditTool(ln.name) ||
                        isFileWriteTool(ln.name) ||
                        isPatchTool(ln.name));
                    const isApprovalTracked =
                      ln.kind === "tool_call" &&
                      ln.toolCallId &&
                      (ln.toolCallId === currentApproval?.toolCallId ||
                        pendingIds.has(ln.toolCallId));
                    if (
                      ln.kind === "tool_call" &&
                      ln.name &&
                      isShellTool(ln.name) &&
                      !isApprovalTracked &&
                      (ln.phase === "streaming" || ln.phase === "ready")
                    ) {
                      return null;
                    }
                    if (isFileTool && !isApprovalTracked) {
                      return null;
                    }
                    if (
                      ln.kind === "tool_call" &&
                      ln.name &&
                      isTaskTool(ln.name) &&
                      ln.toolCallId &&
                      !pendingIds.has(ln.toolCallId) &&
                      ln.toolCallId !== currentApproval?.toolCallId
                    ) {
                      return null;
                    }

                    const matchesCurrentApproval =
                      ln.kind === "tool_call" &&
                      currentApproval &&
                      ln.toolCallId === currentApproval.toolCallId;

                    return (
                      <Box key={ln.id} flexDirection="column" marginTop={1}>
                        {matchesCurrentApproval ? (
                          approvalView
                        ) : ln.kind === "user" ? (
                          <UserMessage line={ln} prompt={statusLinePrompt} />
                        ) : ln.kind === "reasoning" ? (
                          <LiveReasoningMessage line={ln} />
                        ) : ln.kind === "assistant" ? (
                          <AssistantMessage line={ln} />
                        ) : ln.kind === "tool_call" &&
                          ln.toolCallId &&
                          pendingIds.has(ln.toolCallId) ? (
                          <PendingApprovalStub
                            toolName={ln.name ?? "Unknown"}
                          />
                        ) : ln.kind === "tool_call" ? (
                          <ToolCallMessage
                            line={ln}
                            precomputedDiffs={precomputedDiffs}
                            isStreaming={streaming}
                            remote
                          />
                        ) : ln.kind === "error" ? (
                          <ErrorMessage line={ln} />
                        ) : ln.kind === "status" ? (
                          <StatusMessage line={ln} />
                        ) : ln.kind === "event" ? (
                          <EventMessage line={ln} />
                        ) : ln.kind === "command" ? (
                          <CommandMessage line={ln} />
                        ) : ln.kind === "bash_command" ? (
                          <BashCommandMessage line={ln} />
                        ) : null}
                      </Box>
                    );
                  })}
                </Box>
              )}

              {currentApproval &&
                !liveItems.some(
                  (ln) =>
                    ln.kind === "tool_call" &&
                    ln.toolCallId === currentApproval.toolCallId,
                ) && <Box flexDirection="column">{approvalView}</Box>}
              <SubagentGroupDisplay agents={state.subagents ?? []} />
            </AnimationProvider>

            <Box marginTop={1}>
              <Input {...input} collapseInputWhenDisabled={!active} />
            </Box>
            {state.help ? (
              <HelpDialog
                sessionCommands={terminalCommands}
                onClose={() => store.closeHelp()}
              />
            ) : state.login ? (
              <LettaLoginView
                activateCloudBackend={false}
                onComplete={() => store.closeLogin()}
                onCancel={() => store.closeLogin()}
              />
            ) : state.question ? (
              <InlineQuestionApproval
                key={state.question.toolCallId}
                questions={state.question.questions}
                onSubmit={(answers) =>
                  state.question && void store.answer(state.question, answers)
                }
                onCancel={() =>
                  state.question && void store.answer(state.question)
                }
              />
            ) : state.picker ? (
              state.picker.kind === "agents" ? (
                <AgentSelector
                  currentAgentId={state.agentId ?? ""}
                  sessionList={store.listAgents}
                  sessionCollection={store.listAgentCollection}
                  onCreateNewAgent={store.createPickerAgent}
                  onSelect={(id) => void store.select(id)}
                  onCancel={() => store.closePicker()}
                  sessionUnpin={store.unpinPickerAgent}
                  sessionDelete={store.deletePickerAgent}
                />
              ) : state.picker.models ? (
                <SessionModelPicker
                  entries={state.picker.models}
                  handles={state.picker.handles}
                  aliases={state.picker.aliases}
                  currentModel={state.model}
                  local={isLocalAgentId(state.agentId ?? "")}
                  refresh={() => store.send("/model")}
                  onOpenConnect={() => {
                    store.closePicker();
                    void store.send("/connect");
                  }}
                  onSelect={(id) => void store.select(id)}
                  onCancel={() => store.closePicker()}
                />
              ) : (
                <ConversationSelector
                  reader={store.conversations}
                  agentId={state.agentId ?? ""}
                  agentName={state.agentName}
                  currentConversationId={store.conversationId}
                  onSelect={(id) => void store.select(id)}
                  onCancel={() => store.closePicker()}
                />
              )
            ) : state.skills ? (
              <SearchablePicker
                title="Skills · Enter to toggle"
                items={state.skills.map((skill) => ({
                  key: skill.path,
                  label:
                    skill.label +
                    (skill.fixed
                      ? " · installed"
                      : skill.enabled
                        ? " · enabled"
                        : " · enable"),
                  description: skill.description,
                }))}
                onSelect={(path) => void store.toggleSkill(path)}
                onCancel={() => store.closeSkills()}
              />
            ) : state.memory ? (
              <MemfsTreeViewer
                agentId={state.memory.agentId}
                conversationId={state.memory.conversationId}
                entries={state.memory.entries}
                onClose={() => store.closeMemory()}
              />
            ) : null}
          </>
        )}
      </Box>
    </Box>
  );
}
