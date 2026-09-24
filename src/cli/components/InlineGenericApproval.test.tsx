import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { InlineGenericApproval } from "./InlineGenericApproval";

class CaptureStream extends Writable {
  columns = 100;
  rows = 30;
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

// useTerminalRows/useTerminalWidth follow process.stdout resize events.
function resizeProcessStdout(rows: number, columns: number): () => void {
  const saved = {
    rows: Object.getOwnPropertyDescriptor(process.stdout, "rows"),
    columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
  };
  Object.defineProperty(process.stdout, "rows", {
    configurable: true,
    value: rows,
  });
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: columns,
  });
  process.stdout.emit("resize");
  return () => {
    for (const key of ["rows", "columns"] as const) {
      const descriptor = saved[key];
      if (descriptor) {
        Object.defineProperty(process.stdout, key, descriptor);
      } else {
        delete (process.stdout as { rows?: number; columns?: number })[key];
      }
    }
    process.stdout.emit("resize");
  };
}

async function waitForRender(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

function lastFrameLines(chunks: string[]): string[] {
  const frame = chunks.findLast((chunk) => chunk.includes("Enter to select"));
  return stripAnsi(frame ?? "")
    .replace(/\n$/, "")
    .split("\n");
}

test("a 40-line Workflow script in a short terminal keeps the approval header on screen", async () => {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const script = Array.from(
    { length: 40 },
    (_, index) => `await step${index + 1}();`,
  ).join("\n");
  const instance = render(
    <InlineGenericApproval
      toolName="Workflow"
      toolArgs={JSON.stringify({ script })}
      onApprove={() => {}}
      onApproveAlways={() => {}}
      onDeny={() => {}}
      isFocused={false}
    />,
    { stdout, debug: false, patchConsole: false, exitOnCtrlC: false },
  );
  // The resize listener is registered by a passive effect after mount.
  await waitForRender();
  const restore = resizeProcessStdout(stdout.rows, stdout.columns);
  try {
    await waitForRender();
    const frame = lastFrameLines(stdout.chunks);
    // Taller live frames are clipped to their bottom rows, so the whole
    // approval must fit for its header and script start to be visible.
    expect(frame.length).toBeLessThan(stdout.rows);
    expect(frame.join("\n")).toContain("Run Workflow?");
    expect(frame.join("\n")).toContain("await step1();");
    expect(frame.map((line) => line.trim())).toContain("… (25 more lines)");
  } finally {
    restore();
    instance.unmount();
    instance.cleanup();
  }
});
