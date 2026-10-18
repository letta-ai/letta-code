import { afterEach, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Box, render, Text } from "ink";
import stripAnsi from "strip-ansi";
import {
  setSystemRemindersVisible,
  setThinkingExpanded,
  toggleSystemReminderDisplay,
  toggleThinkingDisplay,
} from "@/cli/components/transcript-display-state";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import { StaticTranscript } from "./StaticTranscript";
import type { StaticItem } from "./types";

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

async function waitForRender(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

afterEach(() => {
  setSystemRemindersVisible(false);
  setThinkingExpanded(false);
});

test("system reminder display changes repaint committed transcript rows", async () => {
  setSystemRemindersVisible(false);
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const instance = render(
    <StaticTranscript
      renderEpoch={0}
      items={[
        {
          kind: "user",
          id: "user-1",
          text: "<system-reminder>\nFirst instruction\nSecond instruction\n</system-reminder>\n\nVisible user question",
        },
      ]}
      columns={100}
      statusLinePrompt=">"
      showCompactionsEnabled={true}
      precomputedDiffs={new Map()}
    />,
    {
      stdout,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  await waitForRender();
  const hiddenOutput = stripAnsi(stdout.chunks.join(""));
  expect(hiddenOutput).not.toContain("System reminder");
  expect(hiddenOutput).not.toContain("First instruction");
  expect(hiddenOutput).toContain("Visible user question");

  const visibleStart = stdout.chunks.length;
  setSystemRemindersVisible(true);
  await waitForRender();
  const collapsedOutput = stripAnsi(stdout.chunks.slice(visibleStart).join(""));
  expect(collapsedOutput).toContain(
    "▸ System reminder · 2 lines (ctrl+r to expand)",
  );
  expect(collapsedOutput).not.toContain("First instruction");

  const expandedStart = stdout.chunks.length;
  toggleSystemReminderDisplay();
  await waitForRender();
  const expandedOutput = stripAnsi(stdout.chunks.slice(expandedStart).join(""));
  expect(expandedOutput).toContain("▾ System reminder (ctrl+r to collapse)");
  expect(expandedOutput).toContain("First instruction");

  const recollapsedStart = stdout.chunks.length;
  toggleSystemReminderDisplay();
  await waitForRender();
  expect(stripAnsi(stdout.chunks.slice(recollapsedStart).join(""))).toContain(
    "▸ System reminder · 2 lines (ctrl+r to expand)",
  );

  instance.unmount();
  instance.cleanup();
});

test("thinking display changes repaint committed transcript rows", async () => {
  setThinkingExpanded(false);
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const instance = render(
    <StaticTranscript
      renderEpoch={0}
      items={[
        {
          kind: "reasoning",
          id: "reasoning-1",
          text: "First thought\n\nSecond thought",
          phase: "finished",
          durationMs: 3_600,
        },
      ]}
      columns={100}
      statusLinePrompt=">"
      showCompactionsEnabled={true}
      precomputedDiffs={new Map()}
    />,
    {
      stdout,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  await waitForRender();
  const collapsedOutput = stripAnsi(stdout.chunks.join(""));
  expect(collapsedOutput).toContain("Thought for 4 seconds (ctrl+t to expand)");
  expect(collapsedOutput).not.toContain("First thought");

  const expandedStart = stdout.chunks.length;
  toggleThinkingDisplay();
  await waitForRender();
  const expandedOutput = stripAnsi(stdout.chunks.slice(expandedStart).join(""));
  expect(expandedOutput).toContain(
    "Thought for 4 seconds (ctrl+t to collapse)",
  );
  expect(expandedOutput).toContain("First thought");
  const repaintChunks = stdout.chunks.slice(expandedStart);
  const atomicRepaint = repaintChunks.find((chunk) =>
    chunk.includes("\u001B[2J"),
  );
  expect(atomicRepaint).toContain("\u001B[?2026h");
  expect(atomicRepaint).not.toContain("\u001B[3J");
  expect(atomicRepaint).toContain("First thought");
  expect(atomicRepaint).toContain("\u001B[?2026l");
  expect(repaintChunks.some((chunk) => chunk === "\u001B[2J\u001B[H")).toBe(
    false,
  );

  const recollapsedStart = stdout.chunks.length;
  toggleThinkingDisplay();
  await waitForRender();
  expect(stripAnsi(stdout.chunks.slice(recollapsedStart).join(""))).toContain(
    "Thought for 4 seconds (ctrl+t to expand)",
  );

  instance.unmount();
  instance.cleanup();
});

function OverflowTranscript({ overflow }: { overflow: boolean }) {
  return (
    <>
      <StaticTranscript
        renderEpoch={0}
        items={[
          {
            kind: "reasoning",
            id: "reasoning-overflow",
            text: "Reasoning body that must not return after recollapse",
            phase: "finished",
            durationMs: 3_600,
          },
        ]}
        columns={100}
        statusLinePrompt=">"
        showCompactionsEnabled={true}
        precomputedDiffs={new Map()}
      />
      {overflow && (
        <Box>
          <Text>{Array.from({ length: 10 }, () => "live").join("\n")}</Text>
        </Box>
      )}
    </>
  );
}

function makeDiff(fileName: string): AdvancedDiffSuccess {
  return {
    mode: "advanced",
    fileName,
    oldStr: "const a = 1;\n",
    newStr: "const a = 2;\n",
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        lines: [{ raw: "-const a = 1;" }, { raw: "+const a = 2;" }],
      },
    ],
  };
}

function makeEditToolCall(
  id: string,
  toolCallId: string,
): Extract<StaticItem, { kind: "tool_call" }> {
  return {
    kind: "tool_call",
    id,
    toolCallId,
    name: "Edit",
    argsText: JSON.stringify({
      file_path: `${toolCallId}.ts`,
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    }),
    phase: "finished",
    resultOk: true,
    resultText: "Success",
  };
}

test("committed items release precomputed diff payloads but keep hunks", async () => {
  const precomputedDiffs = new Map<string, AdvancedDiffSuccess>();
  precomputedDiffs.set("call-edit", makeDiff("call-edit.ts"));
  // ApplyPatch-style compound key owned by the same tool call
  precomputedDiffs.set("call-edit:call-edit.ts", makeDiff("call-edit.ts"));
  // Eagerly-committed approval previews share the map entry's object reference
  const previewDiff = makeDiff("preview.ts");
  precomputedDiffs.set("call-preview", previewDiff);
  // No committed item owns this entry, so it must stay intact
  precomputedDiffs.set("call-pending", makeDiff("pending.ts"));

  const items: StaticItem[] = [
    makeEditToolCall("line-edit", "call-edit"),
    {
      kind: "approval_preview",
      id: "approval-preview-call-preview",
      toolCallId: "call-preview",
      toolName: "Edit",
      toolArgs: JSON.stringify({
        file_path: "preview.ts",
        old_string: "const a = 1;",
        new_string: "const a = 2;",
      }),
      precomputedDiff: previewDiff,
    },
  ];

  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const instance = render(
    <StaticTranscript
      renderEpoch={0}
      items={items}
      columns={100}
      statusLinePrompt=">"
      showCompactionsEnabled={true}
      precomputedDiffs={precomputedDiffs}
    />,
    {
      stdout,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  await waitForRender();

  // Full before/after contents are released once committed and rendered...
  expect(precomputedDiffs.get("call-edit")?.oldStr).toBe("");
  expect(precomputedDiffs.get("call-edit")?.newStr).toBe("");
  expect(precomputedDiffs.get("call-edit:call-edit.ts")?.oldStr).toBe("");
  // ...including the reference shared with the approval_preview item...
  expect(previewDiff.oldStr).toBe("");
  expect(previewDiff.newStr).toBe("");
  // ...while hunks stay cached so Static remounts (resize, ctrl+o) can
  // re-render the identical diff.
  expect(precomputedDiffs.get("call-edit")?.hunks).toHaveLength(1);
  expect(previewDiff.hunks).toHaveLength(1);
  // Entries for tool calls that never committed keep their payloads.
  expect(precomputedDiffs.get("call-pending")?.oldStr).toBe("const a = 1;\n");

  // The committed diff still renders from its hunks.
  expect(stripAnsi(stdout.chunks.join(""))).toContain("const a = 2");

  instance.unmount();
  instance.cleanup();
});

test("payload release tracks newly committed items across rerenders", async () => {
  const precomputedDiffs = new Map<string, AdvancedDiffSuccess>();
  precomputedDiffs.set("call-first", makeDiff("first.ts"));
  precomputedDiffs.set("call-second", makeDiff("second.ts"));

  const firstItem = makeEditToolCall("line-first", "call-first");
  const secondItem = makeEditToolCall("line-second", "call-second");

  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const options = {
    stdout,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  };
  const instance = render(
    <StaticTranscript
      renderEpoch={0}
      items={[firstItem]}
      columns={100}
      statusLinePrompt=">"
      showCompactionsEnabled={true}
      precomputedDiffs={precomputedDiffs}
    />,
    options,
  );

  await waitForRender();
  expect(precomputedDiffs.get("call-first")?.oldStr).toBe("");
  expect(precomputedDiffs.get("call-second")?.oldStr).toBe("const a = 1;\n");

  instance.rerender(
    <StaticTranscript
      renderEpoch={0}
      items={[firstItem, secondItem]}
      columns={100}
      statusLinePrompt=">"
      showCompactionsEnabled={true}
      precomputedDiffs={precomputedDiffs}
    />,
  );

  await waitForRender();
  expect(precomputedDiffs.get("call-second")?.oldStr).toBe("");
  expect(precomputedDiffs.get("call-second")?.hunks).toHaveLength(1);

  instance.unmount();
  instance.cleanup();
});

test("repeated transcript repaints replace Ink static output", async () => {
  setThinkingExpanded(false);
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  stdout.rows = 6;
  const instance = render(<OverflowTranscript overflow={false} />, {
    stdout,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  await waitForRender();
  toggleThinkingDisplay();
  await waitForRender();
  toggleThinkingDisplay();
  await waitForRender();

  const overflowStart = stdout.chunks.length;
  instance.rerender(<OverflowTranscript overflow={true} />);
  await waitForRender();
  const overflowOutput = stripAnsi(stdout.chunks.slice(overflowStart).join(""));

  // Overflow must not replay the retained static tail and must not 3J.
  // The collapsed summary and expanded body both stay out of this frame.
  expect(overflowOutput).not.toContain("Thought for 4 seconds");
  expect(overflowOutput).not.toContain(
    "Reasoning body that must not return after recollapse",
  );
  expect(overflowOutput).toContain("live");
  expect(
    stdout.chunks
      .slice(overflowStart)
      .some((chunk) => chunk.includes("\u001B[3J")),
  ).toBe(false);

  instance.unmount();
  instance.cleanup();
});
