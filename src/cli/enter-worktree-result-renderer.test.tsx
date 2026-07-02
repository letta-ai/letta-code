import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { parseEnterWorktreeResult } from "@/cli/components/EnterWorktreeResultRenderer";
import { ToolCallMessage } from "@/cli/components/ToolCallMessageRich";

class CaptureStream extends Writable {
  columns = 120;
  rows = 24;
  isTTY = true;
  chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(String(chunk));
    callback();
  }
}

function createInputStream(): NodeJS.ReadStream {
  const input = new Readable({ read() {} }) as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

const enterWorktreeResult = [
  "Created worktree.",
  "",
  "Path: /Users/loaner/dev/letta-code-prod/.letta/worktrees/render-test-worktree",
  "Branch: letta/render-test-worktree-a90824a8",
  "Base: origin/main",
  "",
  "The conversation working directory was left unchanged.",
  "",
  "Next steps:",
  "- Confirm you are in the new worktree with `git status` before editing.",
  "- Read README, AGENTS.md, or other project setup docs before running commands.",
].join("\n");

async function renderEnterWorktreeToolCall(): Promise<string> {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const instance = render(
    <ToolCallMessage
      line={{
        kind: "tool_call",
        id: "call-enter-worktree",
        toolCallId: "call-enter-worktree",
        name: "EnterWorktree",
        argsText: JSON.stringify({
          name: "render-test-worktree",
          switch_cwd: false,
        }),
        resultText: enterWorktreeResult,
        resultOk: true,
        phase: "finished",
      }}
      isStreaming={false}
    />,
    {
      stdout,
      stdin: createInputStream(),
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  instance.unmount();
  instance.cleanup();

  return stripAnsi(stdout.chunks.join(""));
}

test("parses EnterWorktree tool result fields", () => {
  expect(parseEnterWorktreeResult(enterWorktreeResult)).toEqual({
    path: "/Users/loaner/dev/letta-code-prod/.letta/worktrees/render-test-worktree",
    branch: "letta/render-test-worktree-a90824a8",
    base: "origin/main",
    switchedCwd: false,
  });
});

test("EnterWorktree tool result renders a compact structured summary", async () => {
  const output = await renderEnterWorktreeToolCall();

  expect(output).toContain("EnterWorktree");
  expect(output).toContain("Created worktree");
  expect(output).toContain("Path:");
  expect(output).toContain("render-test-worktree");
  expect(output).toContain("Branch:");
  expect(output).toContain("letta/render-test-worktree-a90824a8");
  expect(output).toContain("Base:");
  expect(output).toContain("origin/main");
  expect(output).toContain("CWD:");
  expect(output).toContain("unchanged");
  expect(output).not.toContain("Next steps");
  expect(output).not.toContain("Confirm you are in the new worktree");
});
