import { Box } from "ink";
import stripAnsi from "strip-ansi";
import type { Line } from "@/cli/helpers/accumulator";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { truncateText } from "@/cli/helpers/truncate-text";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { isRecord } from "@/utils/type-guards";
import { colors } from "./colors";
import { Text } from "./Text";
import { ToolCallHeader } from "./ToolCallHeader";

type SendLine = Pick<
  Extract<Line, { kind: "tool_call" }>,
  "argsText" | "resultText" | "phase"
>;

interface SendDisplay {
  agentId?: string;
  conversationId?: string;
  message: string;
  status:
    | "pending"
    | "sending"
    | "queued"
    | "submission_failed"
    | "acceptance_unknown";
  error?: string;
}

function parseObject(text: string | undefined): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text ?? "");
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function agentAddress(value: unknown): value is string {
  return typeof value === "string" && /^agent-[a-zA-Z0-9-]+$/.test(value);
}

function conversationAddress(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === "default" || /^conv-[a-zA-Z0-9-]+$/.test(value))
  );
}

/** Parse the full receipt, never the generic renderer's clipped JSON preview.
 * Return null for unknown contracts so ordinary tool errors/details survive.
 * Receipt status is authoritative even when historical approval backfill marks
 * every tool response successful. This is presentation only: no polling/state.
 */
export function parseSendAgentMessageDisplay(
  line: SendLine,
): SendDisplay | null {
  const args = parseObject(line.argsText);
  if (!args || !nonempty(args.message)) return null;
  if (args.agent_id !== undefined && !agentAddress(args.agent_id)) return null;
  if (
    args.conversation_id !== undefined &&
    !conversationAddress(args.conversation_id)
  )
    return null;
  if (!args.agent_id && !args.conversation_id) return null;
  if (args.conversation_id === "default" && !args.agent_id) return null;
  if (args.computer !== undefined && !nonempty(args.computer)) return null;

  const display: SendDisplay = {
    agentId: agentAddress(args.agent_id) ? args.agent_id : undefined,
    conversationId: conversationAddress(args.conversation_id)
      ? args.conversation_id
      : undefined,
    message: args.message,
    status: line.phase === "running" ? "sending" : "pending",
  };
  if (line.phase !== "finished") return display;

  const receipt = parseObject(line.resultText);
  if (!receipt || !nonempty(receipt.client_message_id)) return null;
  if (receipt.status === "queued") {
    if (
      !agentAddress(receipt.agent_id) ||
      !conversationAddress(receipt.conversation_id) ||
      !nonempty(receipt.workflow_id) ||
      !nonempty(receipt.super_run_id)
    )
      return null;
  } else if (
    receipt.status === "submission_failed" ||
    receipt.status === "acceptance_unknown"
  ) {
    if (!nonempty(receipt.error)) return null;
  } else {
    return null;
  }

  // Use a resolved destination as a pair, not a mixture of receipt and request
  // addresses (agent-only calls acquire a new conversation during submission).
  if (receipt.agent_id !== undefined || receipt.conversation_id !== undefined) {
    if (
      !agentAddress(receipt.agent_id) ||
      !conversationAddress(receipt.conversation_id)
    )
      return null;
    display.agentId = receipt.agent_id;
    display.conversationId = receipt.conversation_id;
  }
  display.status = receipt.status;
  display.error = nonempty(receipt.error) ? receipt.error : undefined;
  return display;
}

function preview(text: string, width: number): string {
  return truncateText(stripAnsi(text).replace(/\s+/g, " ").trim(), width);
}

export function SendAgentMessageRenderer({
  display,
  phase,
  isStreaming,
}: {
  display: SendDisplay;
  phase: SendLine["phase"];
  isStreaming?: boolean;
}) {
  const columns = useTerminalWidth();
  const width = Math.max(1, columns - 5);
  const isError =
    display.status === "submission_failed" ||
    display.status === "acceptance_unknown";
  const target = [
    display.agentId,
    display.conversationId ??
      (display.agentId ? "new conversation" : undefined),
  ]
    .filter((value): value is string => !!value)
    .map((value) => preview(value, Math.max(1, width - 4)))
    .join(" · ");
  const status = {
    pending: "Pending",
    sending: "Sending…",
    queued: "Queued",
    submission_failed: "Couldn’t send",
    acceptance_unknown: "Couldn’t confirm send",
  }[display.status];

  return (
    <Box flexDirection="column">
      <ToolCallHeader
        name="SendAgentMessage"
        columns={columns}
        phase={phase}
        resultOk={!isError}
        isStreaming={isStreaming}
      />
      <Box paddingLeft={5} width={columns} flexDirection="column">
        <Text dimColor wrap="wrap">
          To: {target}
        </Text>
        <Text wrap="truncate-end">
          {preview(display.message, Math.min(240, width))}
        </Text>
      </Box>
      <Box flexDirection="row">
        <Box width={5} flexShrink={0}>
          <Text>{`  ${CLI_GLYPHS.result}  `}</Text>
        </Box>
        <Box width={width} flexGrow={1} flexDirection="column">
          <Text
            color={isError ? colors.status.error : undefined}
            dimColor={!isError}
          >
            {status}
          </Text>
          {display.error && (
            <Text color={colors.status.error}>
              {preview(display.error, Math.min(240, width * 2))}
            </Text>
          )}
          {display.status === "acceptance_unknown" && (
            <Text dimColor>Check the conversation before resending.</Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
