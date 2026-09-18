import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { Box, render } from "ink";
import stripAnsi from "strip-ansi";
import { StaticTranscript } from "@/cli/app/StaticTranscript";
import {
  collectStaticTranscriptItems,
  selectLiveTranscriptItems,
  type TranscriptCommitState,
} from "@/cli/app/transcript-promotion";
import type { StaticItem } from "@/cli/app/types";
import { AssistantMessage } from "@/cli/components/AssistantMessageRich";
import { ReasoningMessage } from "@/cli/components/ReasoningMessageRich";
import {
  createBuffers,
  type Line,
  markCurrentLineAsFinished,
  onChunk,
  toLines,
} from "@/cli/helpers/accumulator";

class CaptureStream extends Writable {
  rows = 12;
  isTTY = true;
  frames: string[] = [];

  constructor(readonly columns: number) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    const frame = stripAnsi(String(chunk));
    if (frame.trim()) this.frames.push(frame);
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

function transcript(items: StaticItem[], live: Line[], columns: number) {
  return (
    <Box flexDirection="column">
      <StaticTranscript
        renderEpoch={0}
        items={items}
        columns={columns}
        statusLinePrompt=">"
        showCompactionsEnabled={true}
        precomputedDiffs={new Map()}
      />
      {live.map((line) =>
        line.kind === "assistant" ? (
          <AssistantMessage key={line.id} line={line} />
        ) : line.kind === "reasoning" ? (
          <ReasoningMessage key={line.id} line={line} />
        ) : null,
      )}
    </Box>
  );
}

function assistant(content: string): LettaStreamingResponse {
  return {
    message_type: "assistant_message",
    id: "answer",
    otid: "answer-otid",
    date: "2026-09-18T00:00:00Z",
    content: [{ type: "text", text: content }],
  };
}

function reasoning(content: string): LettaStreamingResponse {
  return {
    message_type: "reasoning_message",
    id: "reasoning",
    otid: "reasoning-otid",
    date: "2026-09-18T00:00:00Z",
    reasoning: content,
  };
}

for (const columns of [40, 120]) {
  for (const tokenStreamingEnabled of [true, false]) {
    test(`interleaved transcript renders once at ${columns} columns, streaming=${tokenStreamingEnabled}`, async () => {
      const previousColumns = Object.getOwnPropertyDescriptor(
        process.stdout,
        "columns",
      );
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        value: columns,
      });
      process.stdout.emit("resize");

      const stdout = new CaptureStream(columns);
      const instance = render(transcript([], [], columns), {
        stdout: stdout as CaptureStream & NodeJS.WriteStream,
        stdin: inputStream(),
        // Debug frames contain both accumulated Static output and the live area,
        // so the final frame can assert content and order without parsing VT100.
        debug: true,
        patchConsole: false,
        exitOnCtrlC: false,
      });
      const b = createBuffers();
      b.tokenStreamingEnabled = tokenStreamingEnabled;
      const state: TranscriptCommitState = {
        emittedIds: new Set(),
        deferredCommits: new Map(),
        eagerCommittedPreviews: new Set(),
      };
      const items: StaticItem[] = [];
      async function refresh() {
        items.push(...collectStaticTranscriptItems(b, state).items);
        const live = selectLiveTranscriptItems(toLines(b), state.emittedIds, {
          tokenStreamingEnabled,
          showCompactionsEnabled: true,
        });
        instance.rerender(transcript([...items], live, columns));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      try {
        onChunk(b, reasoning("THOUGHT_START "));
        onChunk(b, assistant("ANSWER_START\n\n```js\nconsole.log("));
        await refresh();
        onChunk(b, reasoning("THOUGHT_END"));
        await refresh();
        onChunk(b, assistant('"CODE_COMPLETE");\n```\n\n'));
        // More than a screen of output also exercises safe paragraph promotion
        // while the preceding reasoning line is still open.
        onChunk(
          b,
          assistant(
            Array.from(
              { length: 60 },
              (_, index) =>
                `ROW_${index.toString().padStart(2, "0")} ${"word ".repeat(8)}`,
            ).join("\n") + "\n\n",
          ),
        );
        await refresh();
        onChunk(b, assistant("ANSWER_END"));
        markCurrentLineAsFinished(b);
        await refresh();

        const frame = stdout.frames.at(-1) ?? "";
        for (const marker of [
          "THOUGHT_START",
          "THOUGHT_END",
          "ANSWER_START",
          "CODE_COMPLETE",
          "ROW_00",
          "ROW_59",
          "ANSWER_END",
        ]) {
          expect(frame.split(marker)).toHaveLength(2);
        }
        expect(frame.indexOf("THOUGHT_START")).toBeLessThan(
          frame.indexOf("ANSWER_START"),
        );
        expect(frame.indexOf("ROW_59")).toBeLessThan(
          frame.indexOf("ANSWER_END"),
        );
        expect(frame).not.toContain("```");
        expect(
          selectLiveTranscriptItems(toLines(b), state.emittedIds, {
            tokenStreamingEnabled,
            showCompactionsEnabled: true,
          }),
        ).toHaveLength(0);
      } finally {
        instance.unmount();
        instance.cleanup();
        if (previousColumns) {
          Object.defineProperty(process.stdout, "columns", previousColumns);
        } else {
          Reflect.deleteProperty(process.stdout, "columns");
        }
        process.stdout.emit("resize");
      }
    });
  }
}
