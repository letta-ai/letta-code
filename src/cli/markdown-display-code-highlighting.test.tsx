import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { MarkdownDisplay } from "@/cli/components/MarkdownDisplay";
import { highlightCode } from "@/cli/components/SyntaxHighlightedCommand";

class CaptureStream extends Writable {
  columns = 100;
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

async function renderMarkdown(markdown: string): Promise<string> {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const instance = render(<MarkdownDisplay text={markdown} />, {
    stdout,
    stdin: createInputStream(),
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  instance.unmount();
  instance.cleanup();

  return stdout.chunks.join("");
}

test("markdown fenced code blocks use syntax highlighting when language is provided", async () => {
  const output = await renderMarkdown(
    `Here is Python:\n\n\`\`\`python\ndef greet(name: str) -> str:\n    return f"Hello, {name}!"\n\`\`\``,
  );
  const plain = stripAnsi(output);
  const highlighted = highlightCode(
    'def greet(name: str) -> str:\n    return f"Hello, {name}!"\n\nprint(greet("world"))',
    "python",
  );

  expect(plain).toContain("def greet(name: str) -> str:");
  expect(plain).toContain('return f"Hello, {name}!"');
  expect(highlighted?.[0]?.map((span) => span.color)).toEqual([
    "#CBA6F7",
    "#CDD6F4",
    "#89B4FA",
    "#9399B2",
    "#EBA0AC",
    "#9399B2",
    "#EBA0AC",
    "#CBA6F7",
    "#9399B2",
    "#CDD6F4",
    "#9399B2",
    "#CDD6F4",
    "#CBA6F7",
    "#9399B2",
  ]);
  expect(highlighted?.[1]?.map((span) => span.color)).toContain("#A6E3A1");
  expect(highlighted?.[0]?.find((span) => span.text === "greet")?.color).toBe(
    "#89B4FA",
  );
  expect(highlighted?.[3]?.find((span) => span.text === "print")?.color).toBe(
    "#FAB387",
  );
  expect(highlighted?.[3]?.find((span) => span.text === "greet")?.color).toBe(
    "#89B4FA",
  );
});

test("markdown code block fallback renders plain code content", async () => {
  const output = await renderMarkdown("```\nbun run check\n```");

  expect(stripAnsi(output)).toContain("bun run check");
});

test("markdown renders indented fenced code blocks inside list items", async () => {
  const output = await renderMarkdown(
    [
      "1. Immediately, via the tool result",
      "   EnterWorktree returns text like:",
      "   ```txt",
      "   Created worktree.",
      "",
      "   Path: /tmp/worktree",
      "   ```",
    ].join("\n"),
  );
  const plain = stripAnsi(output);

  expect(plain).toContain("1. Immediately, via the tool result");
  expect(plain).toContain("Created worktree.");
  expect(plain).toContain("Path: /tmp/worktree");
  expect(plain).not.toContain("```txt");
  expect(plain).not.toContain("```");
});

test("MarkdownDisplay wires fenced code blocks through syntax highlighting", () => {
  const sourcePath = fileURLToPath(
    new URL("../cli/components/MarkdownDisplay.tsx", import.meta.url),
  );
  const source = readFileSync(sourcePath, "utf-8");

  expect(source).toContain("highlightCode(code, language)");
  expect(source).toMatch(/languageFromPath\(`code\.\$\{normalized\}`\)/);
  expect(source).toContain("colors.shellSyntax.string");
  expect(source).not.toContain("color={colors.code.inline}");
});
