import { Box, Text, useInput } from "ink";
import { useState, useSyncExternalStore } from "react";
import { isAskUserQuestions } from "@/ask-user-question";
import { ApprovalSwitch } from "@/cli/components/ApprovalSwitch";
import { AssistantMessage } from "@/cli/components/AssistantMessageRich";
import { InlineQuestionApproval } from "@/cli/components/InlineQuestionApproval";
import { MemfsTreeViewer } from "@/cli/components/MemfsTreeViewer";
import { PasteAwareTextInput } from "@/cli/components/PasteAwareTextInput";
import { ReasoningMessage } from "@/cli/components/ReasoningMessageRich";
import { SessionDiff } from "@/cli/components/SessionDiff";
import { ToolCallMessage } from "@/cli/components/ToolCallMessageRich";
import { UserMessage } from "@/cli/components/UserMessageRich";
import type { DiffPreview } from "@/types/protocol_v2";
import type { TerminalSession } from "./terminal-session";

export function TerminalApp({ store }: { store: TerminalSession }) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const [draft, setDraft] = useState("");

  const approval = state.approvals[0];
  const suggestion = approval?.context?.permissionSuggestions?.[0];
  useInput((input, key) => {
    if (approval || state.memory) return;
    if (key.shift && key.tab) void store.cyclePermissionMode();
    else if (key.escape) void store.interrupt();
    else if (state.status === "offline" && input === "r") void store.connect();
  });
  return (
    <Box flexDirection="column">
      {state.rows.map((row) =>
        row.kind === "assistant" ? (
          <AssistantMessage
            key={row.key}
            line={{
              kind: "assistant",
              id: row.key,
              text: row.text,
              phase: "streaming",
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
              phase: state.activity ? "streaming" : "finished",
            }}
          />
        ),
      )}
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
          {state.status} · {state.device.permissionMode} ·{" "}
          {state.device.workingDirectory}
        </Text>
      )}
      {Array.isArray(state.device?.raw?.background_processes) &&
        state.device.raw.background_processes.map((item) => (
          <Text key={item.process_id} dimColor>
            {item.kind} · {item.description ?? item.command} · {item.status}
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
      ) : state.memory ? (
        <MemfsTreeViewer
          agentId={state.memory.agentId}
          entries={state.memory.entries}
          onClose={() => store.closeMemory()}
        />
      ) : state.status === "online" ? (
        <Box>
          <Text>❯ </Text>
          <PasteAwareTextInput
            placeholder="Message · /help for commands"
            value={draft}
            onChange={setDraft}
            onSubmit={(value) => {
              if (value.trim()) {
                setDraft("");
                void store.send(value);
              }
            }}
          />
        </Box>
      ) : (
        <Text>
          {state.status === "offline"
            ? "Disconnected · r to reconnect"
            : "Connecting…"}
        </Text>
      )}
    </Box>
  );
}
