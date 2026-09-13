import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { parseExitWorktreeResult } from "@/cli/components/ExitWorktreeResultRenderer";
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

const removedWorktreeResult = [
  "Removed worktree.",
  "",
  "Path: /Users/loaner/dev/letta-code-prod/.letta/worktrees/render-test-worktree",
  "Branch: deleted letta/render-test-worktree-a90824a8",
  "Lock: released",
  "CWD: /Users/loaner/dev/letta-code-prod",
  "",
  "This conversation's working directory is now the primary checkout.",
].join("\n");

const keptWorktreeResult = [
  "Left worktree.",
  "",
  "Path: /Users/loaner/dev/letta-code-prod/.letta/worktrees/render-test-worktree",
  "Branch: letta/render-test-worktree-a90824a8",
  "CWD: /Users/loaner/dev/letta-code-prod",
  "",
  "This conversation's working directory is now the primary checkout.",
  "",
  "The worktree and its branch were left on disk; re-enter it with EnterWorktree `path`.",
].join("\n");

async function renderExitWorktreeToolCall(
  resultText = removedWorktreeResult,
): Promise<string> {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const instance = render(
    <ToolCallMessage
      line={{
        kind: "tool_call",
        id: "call-exit-worktree",
        toolCallId: "call-exit-worktree",
        name: "ExitWorktree",
        argsText: JSON.stringify({ action: "remove" }),
        resultText,
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

test("parses ExitWorktree tool result fields", () => {
  expect(parseExitWorktreeResult(removedWorktreeResult)).toEqual({
    action: "removed",
    path: "/Users/loaner/dev/letta-code-prod/.letta/worktrees/render-test-worktree",
    branch: "deleted letta/render-test-worktree-a90824a8",
    lock: "released",
    cwd: "/Users/loaner/dev/letta-code-prod",
    switchedCwd: true,
  });
});

test("ExitWorktree tool result renders a compact structured summary", async () => {
  const output = await renderExitWorktreeToolCall();

  expect(output).toContain("ExitWorktree");
  expect(output).toContain("Removed worktree");
  expect(output).toContain("Path:");
  expect(output).toContain("render-test-worktree");
  expect(output).toContain("Branch:");
  expect(output).toContain("deleted letta/render-test-worktree-a90824a8");
  expect(output).toContain("Lock:");
  expect(output).toContain("released");
  expect(output).toContain("CWD:");
  expect(output).not.toContain("This conversation's working directory");
});

test("ExitWorktree tool result distinguishes a kept worktree", async () => {
  expect(parseExitWorktreeResult(keptWorktreeResult)).toEqual({
    action: "left",
    path: "/Users/loaner/dev/letta-code-prod/.letta/worktrees/render-test-worktree",
    branch: "letta/render-test-worktree-a90824a8",
    lock: undefined,
    cwd: "/Users/loaner/dev/letta-code-prod",
    switchedCwd: true,
  });

  const output = await renderExitWorktreeToolCall(keptWorktreeResult);

  expect(output).toContain("Left worktree (kept on disk)");
  expect(output).not.toContain("Removed worktree");
  expect(output).not.toContain("Lock:");
  expect(output).not.toContain("re-enter it with EnterWorktree");
});

test("ExitWorktree renderer flags a working directory that did not switch", async () => {
  const strandedResult = [
    "Removed worktree.",
    "",
    "Path: /repo/.letta/worktrees/stranded",
    "Branch: deleted letta/stranded-1234",
    "CWD: /repo",
    "",
    "⚠ The working directory could not be switched and may still point at /repo/.letta/worktrees/stranded.",
  ].join("\n");

  expect(parseExitWorktreeResult(strandedResult)?.switchedCwd).toBe(false);

  const output = await renderExitWorktreeToolCall(strandedResult);
  expect(output).toContain("not switched");
});

test("non-ExitWorktree text is not claimed by the parser", () => {
  expect(
    parseExitWorktreeResult("Created worktree.\n\nPath: /repo"),
  ).toBeNull();
  expect(parseExitWorktreeResult("Not in a managed worktree.")).toBeNull();
  expect(parseExitWorktreeResult("Removed worktree.")).toBeNull();
});
