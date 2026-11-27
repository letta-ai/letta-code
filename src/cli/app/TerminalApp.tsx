import type { TranscriptRow } from "@letta-ai/letta-agent-sdk";
import { Box, Static, Text, useInput, useStdout } from "ink";
import { useCallback, useSyncExternalStore } from "react";
import { isAskUserQuestions } from "@/ask-user-question";
import { ApprovalSwitch } from "@/cli/components/ApprovalSwitch";
import { AssistantMessage } from "@/cli/components/AssistantMessageRich";
import { InlineQuestionApproval } from "@/cli/components/InlineQuestionApproval";
import { MemfsTreeViewer } from "@/cli/components/MemfsTreeViewer";
import { ReasoningMessage } from "@/cli/components/ReasoningMessageRich";
import { SessionDiff } from "@/cli/components/SessionDiff";
import { ToolCallMessage } from "@/cli/components/ToolCallMessageRich";
import { UserMessage } from "@/cli/components/UserMessageRich";
import type { DiffPreview } from "@/types/protocol_v2";
import { CLEAR_SCREEN_AND_HOME } from "./constants";
import { SessionPicker } from "./SessionPicker";
import { TerminalComposer } from "./TerminalComposer";
import type { TerminalSession } from "./terminal-session";

function TerminalRow({ row, live }: { row: TranscriptRow; live: boolean }) {
  return row.kind === "assistant" ? (
    <AssistantMessage
      key={row.key}
      line={{
        kind: "assistant",
        id: row.key,
        text: row.text,
        phase: live ? "streaming" : "finished",
      }}
    />
  ) : row.kind === "user" ? (
    <UserMessage
      key={row.key}
      line={{ kind: "user", id: row.key, text: row.text }}
    />
  ) : row.kind === "tool_call" ? (
    <ToolCallMessage
      key={row.key}
      remote
      line={{
        kind: "tool_call",
        id: row.key,
        toolCallId: row.toolCallId,
        name: row.toolName,
        argsText: row.rawArguments ?? JSON.stringify(row.toolInput),
        phase: row.status === "complete" ? "finished" : row.status,
        resultOk: row.result && !row.result.isError,
        resultText: row.result?.content,
      }}
    />
  ) : (
    <ReasoningMessage
      key={row.key}
      line={{
        kind: "reasoning",
        id: row.key,
        text: row.text,
        phase: live ? "streaming" : "finished",
      }}
    />
  );
}

export function TerminalApp({ store }: { store: TerminalSession }) {
  const { stdout } = useStdout();
  const subscribe = useCallback(
    (notify: () => void) => {
      let epoch = store.snapshot().epoch;
      return store.subscribe(() => {
        const next = store.snapshot().epoch;
        if (epoch !== next) stdout.write(CLEAR_SCREEN_AND_HOME);
        epoch = next;
        notify();
      });
    },
    [store, stdout],
  );
  const state = useSyncExternalStore(subscribe, store.snapshot);

  const approval = state.approvals[0];
  const suggestion = approval?.context?.permissionSuggestions?.[0];
  useInput((input, key) => {
    if (approval || state.question || state.memory || state.picker) return;
    if (key.shift && key.tab) void store.cyclePermissionMode();
    else if (key.escape) void store.interrupt();
    else if (state.status === "offline" && input === "r") void store.connect();
  });
  return (
    <Box flexDirection="column">
      <Static key={state.epoch} items={state.rows.slice(0, state.committed)}>
        {(row) => <TerminalRow key={row.key} row={row} live={false} />}
      </Static>
      {state.rows.slice(state.committed).map((row) => (
        <TerminalRow key={row.key} row={row} live />
      ))}
      {state.activity && <Text dimColor>{state.activity}</Text>}
      {state.queue.map((item, index) => (
        <Text key={item.id} dimColor>
          Queued {index + 1}.{" "}
          {typeof item.content === "string"
            ? item.content
            : JSON.stringify(item.content)}
        </Text>
      ))}
      {state.queue.length > 0 && (
        <Text dimColor>/queue remove &lt;number&gt;</Text>
      )}
      {state.device && (
        <Text dimColor>
          {state.status} · {state.model} · {state.device.permissionMode} ·{" "}
          {state.device.workingDirectory}{" "}
          {state.tokens !== undefined && `· ${state.tokens} tokens`}
        </Text>
      )}
      {Array.isArray(state.device?.raw?.background_processes) &&
        state.device.raw.background_processes.map((item) => (
          <Text key={item.process_id} dimColor>
            {item.kind} · {item.description ?? item.command} · {item.status}
          </Text>
        ))}
      {state.subagents?.map((agent) => (
        <Text key={agent.id} dimColor>
          {agent.description} · {agent.status}
        </Text>
      ))}
      {state.commandOutput && <Text>{state.commandOutput}</Text>}
      {state.error && <Text color="red">{state.error}</Text>}
      {approval ? (
        <Box
          key={approval.context?.requestId ?? approval.context?.toolCallId}
          flexDirection="column"
        >
          <Text>
            {approval.name} {JSON.stringify(approval.input)}
          </Text>
          {(approval.context?.diffs as DiffPreview[] | undefined)?.map(
            (preview, index) => (
              <SessionDiff
                key={`${preview.fileName}-${index}`}
                preview={preview}
              />
            ),
          )}
          {approval.name === "AskUserQuestion" &&
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
              showPreview={false}
              fileHeader={approval.name}
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
          )}
        </Box>
      ) : state.question ? (
        <InlineQuestionApproval
          key={state.question.toolCallId}
          questions={state.question.questions}
          onSubmit={(answers) =>
            state.question && void store.answer(state.question, answers)
          }
          onCancel={() => state.question && void store.answer(state.question)}
        />
      ) : state.picker ? (
        <SessionPicker
          key={state.picker.kind}
          picker={state.picker}
          store={store}
        />
      ) : state.memory ? (
        <MemfsTreeViewer
          agentId={state.memory.agentId}
          entries={state.memory.entries}
          onClose={() => store.closeMemory()}
        />
      ) : state.status !== "online" ? (
        <Text>
          {state.status === "offline"
            ? "Disconnected · r to reconnect"
            : "Connecting…"}
        </Text>
      ) : null}
      <TerminalComposer
        store={store}
        active={
          state.status === "online" &&
          !approval &&
          !state.question &&
          !state.memory &&
          !state.picker
        }
      />
    </Box>
  );
}
