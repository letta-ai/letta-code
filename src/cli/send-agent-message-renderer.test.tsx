import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import type { ComponentProps } from "react";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { StaticTranscript } from "@/cli/app/StaticTranscript";
import { parseSendAgentMessageDisplay } from "@/cli/components/SendAgentMessageRenderer";
import { ToolCallMessage } from "@/cli/components/ToolCallMessageRich";
import {
  createBuffers,
  onChunk,
  setToolCallsRunning,
  toLines,
} from "@/cli/helpers/accumulator";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";

type ToolLine = ComponentProps<typeof ToolCallMessage>["line"];
const args = {
  conversation_id: "conv-request",
  message:
    "Please check the tests and send a concise update to this conversation.",
};
const receipt = {
  status: "queued",
  agent_id: "agent-resolved",
  conversation_id: "conv-resolved",
  client_message_id: "message-1",
  workflow_id: "workflow-1",
  super_run_id: "run-1",
  status_command:
    "letta messages status --agent agent-resolved --conversation conv-resolved",
  messages_command:
    "letta messages list --agent agent-resolved --conversation conv-resolved",
};
const line: ToolLine = {
  kind: "tool_call",
  id: "call-send",
  toolCallId: "call-send",
  name: "SendAgentMessage",
  argsText: JSON.stringify(args),
  phase: "finished",
  resultOk: true,
  resultText: JSON.stringify(receipt),
};

class CaptureStream extends Writable {
  columns: number;
  rows = 60;
  isTTY = true;
  chunks: string[] = [];
  constructor(columns: number) {
    super();
    this.columns = columns;
  }
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(String(chunk));
    callback();
  }
}
function inputStream(): NodeJS.ReadStream {
  const input = new Readable({ read() {} }) as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
function WidthProbe() {
  useTerminalWidth();
  return null;
}

async function capture(
  toolLine: ToolLine,
  columns = 100,
  historical = false,
): Promise<string> {
  const stdout = new CaptureStream(columns) as CaptureStream &
    NodeJS.WriteStream;
  const options = {
    stdout,
    stdin: inputStream(),
    patchConsole: false,
    exitOnCtrlC: false,
  };
  const originalColumns = process.stdout.columns;
  // The production hook observes process.stdout, not Ink's injected output.
  process.stdout.columns = columns;
  // Keep a separate probe alive through teardown so restoring the shared width
  // cannot repaint the tool at the original width before Ink flushes it.
  const probe = render(<WidthProbe />, {
    ...options,
    stdout: new CaptureStream(columns) as CaptureStream & NodeJS.WriteStream,
    stdin: inputStream(),
  });
  await tick();
  process.stdout.emit("resize");
  await tick();
  const instance = render(
    historical ? (
      <StaticTranscript
        renderEpoch={0}
        items={[toolLine]}
        columns={columns}
        statusLinePrompt=">"
        showCompactionsEnabled={false}
        precomputedDiffs={new Map()}
      />
    ) : (
      <ToolCallMessage
        line={toolLine}
        isStreaming={toolLine.phase === "streaming"}
      />
    ),
    options,
  );
  try {
    await tick();
  } finally {
    // CI buffers live output until unmount. Flush at the requested width first.
    instance.unmount();
    instance.cleanup();
    process.stdout.columns = originalColumns;
    process.stdout.emit("resize");
    probe.unmount();
    probe.cleanup();
  }
  return stripAnsi(stdout.chunks.join(""));
}

for (const phase of ["streaming", "ready", "running", "finished"] as const) {
  test(`actual tool row displays ${phase} without recipient progress`, async () => {
    const output = await capture({
      ...line,
      phase,
      resultText: phase === "finished" ? line.resultText : undefined,
    });
    expect(output).toContain(
      phase === "finished"
        ? "Queued"
        : phase === "running"
          ? "Sending…"
          : "Pending",
    );
    expect(output).toContain(
      "Please check the tests and send a concise update",
    );
    for (const unwanted of [
      "Done",
      "Thinking",
      "tool uses",
      "workflow_id",
      "status_command",
      "Running in the background",
    ])
      expect(output).not.toContain(unwanted);
  });
}

for (const destination of [
  { agent_id: "agent-request" },
  { conversation_id: "conv-request" },
  { agent_id: "agent-request", conversation_id: "default" },
  { agent_id: "agent-request", conversation_id: "conv-request" },
]) {
  test(`request and resolved destination stay distinct: ${JSON.stringify(destination)}`, async () => {
    const pendingLine = {
      ...line,
      phase: "running" as const,
      argsText: JSON.stringify({ ...destination, message: args.message }),
      resultText: undefined,
    };
    const pending = await capture(pendingLine);
    for (const address of Object.values(destination))
      expect(pending).toContain(address);
    expect(pending).not.toContain("agent-resolved");
    if (!("conversation_id" in destination))
      expect(pending).toContain("new conversation");
    const completed = await capture({
      ...pendingLine,
      phase: "finished",
      resultText: line.resultText,
    });
    expect(completed).toContain("agent-resolved");
    expect(completed).toContain("conv-resolved");
    expect(completed).not.toContain("agent-request");
    expect(completed).not.toContain("conv-request");
    expect(completed).not.toContain("new conversation");
  });
}

for (const status of ["submission_failed", "acceptance_unknown"] as const) {
  for (const resultOk of [true, false]) {
    test(`receipt ${status} wins over resultOk=${resultOk}`, async () => {
      const output = await capture({
        ...line,
        resultOk,
        resultText: JSON.stringify({
          ...receipt,
          status,
          error: "Connection refused",
        }),
      });
      expect(output).toContain(
        status === "submission_failed"
          ? "Couldn’t send"
          : "Couldn’t confirm send",
      );
      expect(output).toContain("Connection refused");
      expect(output).not.toContain("Queued");
      expect(output.includes("Check the conversation before resending.")).toBe(
        status === "acceptance_unknown",
      );
    });
  }
}

test("queued receipt wins over misleading historical failure flag", async () => {
  expect(await capture({ ...line, resultOk: false }, 100, true)).toContain(
    "Queued",
  );
});

test("pre-submission error retains request destination and parses before clipping", async () => {
  const error = {
    status: "submission_failed",
    client_message_id: "message-1",
    padding: "x".repeat(500),
    error: "Cloud backend required",
  };
  const output = await capture({
    ...line,
    resultText: JSON.stringify(error),
    resultOk: false,
  });
  expect(output).toContain("conv-request");
  expect(output).toContain("Cloud backend required");
  expect(output).not.toContain("padding");
});

for (const argsText of [
  undefined,
  "{",
  "null",
  "[]",
  "{}",
  JSON.stringify({ message: "hello", conversation_id: "default" }),
  JSON.stringify({ ...args, message: 42 }),
  JSON.stringify({ ...args, agent_id: 42 }),
]) {
  test(`malformed or partial arguments stay generic: ${argsText}`, async () => {
    const partial = {
      ...line,
      argsText,
      phase: "streaming" as const,
      resultText: undefined,
    };
    expect(parseSendAgentMessageDisplay(partial)).toBeNull();
    const output = await capture(partial);
    expect(output).toContain("SendAgentMessage");
    expect(output).not.toContain("Sending");
    expect(output).not.toContain("Queued");
    expect(output).not.toContain("render error");
  });
}

for (const resultText of [
  undefined,
  "{",
  "null",
  "[]",
  "unrecognized result",
  JSON.stringify({ status: "queued" }),
  JSON.stringify({ ...receipt, status: "completed" }),
  JSON.stringify({ ...receipt, agent_id: 3 }),
  JSON.stringify({ ...receipt, status: "acceptance_unknown", error: null }),
]) {
  test(`unknown or partial result stays generic: ${resultText}`, async () => {
    const unknown = { ...line, resultText };
    expect(parseSendAgentMessageDisplay(unknown)).toBeNull();
    const output = await capture(unknown);
    expect(output).not.toContain("Queued");
    expect(output).not.toContain("Couldn’t");
    expect(output).not.toContain("render error");
  });
}

test("denial and interruption keep existing generic error text", async () => {
  expect(
    await capture({
      ...line,
      resultOk: false,
      resultText:
        "Error: request to call tool denied. User reason: Do not send yet",
    }),
  ).toContain("User rejected the tool call with reason: Do not send yet");
  expect(
    await capture({
      ...line,
      resultOk: false,
      resultText: "Interrupted by user",
    }),
  ).toContain("Interrupted by user");
});

for (const columns of [24, 40, 80, 120]) {
  test(`long text is bounded and identifiers fit at ${columns} columns`, async () => {
    const output = await capture(
      {
        ...line,
        argsText: JSON.stringify({
          ...args,
          message: `Review 日本語 tests\n${"long message ".repeat(100)} END-MARKER`,
        }),
        resultText: JSON.stringify({
          ...receipt,
          agent_id: `agent-${"a".repeat(80)}`,
          conversation_id: `conv-${"b".repeat(80)}`,
        }),
      },
      columns,
    );
    expect(output).toContain("Review");
    expect(output).toContain("...");
    expect(output).not.toContain("END-MARKER");
    for (const row of output.split("\n"))
      expect(stringWidth(row)).toBeLessThanOrEqual(columns);
    expect(output.split("\n").length).toBeLessThan(16);
  });
}

test("static transcript renders the same compact receipt without mutating raw details", async () => {
  const original = JSON.stringify(line);
  const output = await capture(line, 120, true);
  expect(output).toContain("Queued");
  expect(output).toContain("conv-resolved");
  expect(output).not.toContain("workflow_id");
  expect(JSON.stringify(line)).toBe(original);
  expect(line.resultText).toContain("workflow_id");
  expect(line.argsText).toContain(args.message);
});

test("real accumulator moves the send from running to queued only on receipt", async () => {
  const buffers = createBuffers();
  onChunk(buffers, {
    message_type: "approval_request_message",
    id: "request",
    date: new Date().toISOString(),
    tool_call: {
      tool_call_id: "call-send",
      name: "SendAgentMessage",
      arguments: JSON.stringify(args),
    },
  });
  setToolCallsRunning(buffers, ["call-send"]);
  const running = toLines(buffers).find((item) => item.kind === "tool_call");
  if (!running || running.kind !== "tool_call")
    throw new Error("Missing tool call");
  expect(await capture(running)).toContain("Sending…");
  onChunk(buffers, {
    message_type: "tool_return_message",
    id: "return",
    date: new Date().toISOString(),
    tool_call_id: "call-send",
    tool_return: JSON.stringify(receipt),
    status: "success",
  });
  const finished = toLines(buffers).find((item) => item.kind === "tool_call");
  if (!finished || finished.kind !== "tool_call")
    throw new Error("Missing tool return");
  const output = await capture(finished, 100, true);
  expect(output).toContain("Queued");
  expect(output).not.toContain("Sending…");
});

test("header extraction preserves ordinary shell and file tool presentation", async () => {
  const shell = await capture({
    ...line,
    name: "Bash",
    argsText: JSON.stringify({ command: "printf hello" }),
    resultText: "hello",
  });
  expect(shell).toContain("hello");
  expect(shell).not.toContain("SendAgentMessage");
  const read = await capture({
    ...line,
    name: "Read",
    argsText: JSON.stringify({ file_path: "/tmp/example.ts" }),
    resultText: "one\ntwo",
  });
  expect(read).toContain("Read");
  expect(read).toContain("example.ts");
  expect(read).toContain("2 lines");
});
