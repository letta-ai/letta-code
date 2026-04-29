import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("listen retry wiring", () => {
  test("post-stop retries refresh OTIDs before resending", () => {
    const turnPath = fileURLToPath(
      new URL("../../websocket/listener/turn.ts", import.meta.url),
    );
    const source = readFileSync(turnPath, "utf-8");

    expect(source).toContain("refreshInputOtidsForNewRequest");

    const emptyResponseStart = source.indexOf(
      "if (\n          isEmptyResponseRetryable(",
    );
    const transientRetryStart = source.indexOf(
      "const retriable = await isRetriablePostStopError(",
    );
    const terminalHandlingStart = source.indexOf(
      "const effectiveStopReason: StopReasonType =",
    );

    expect(emptyResponseStart).toBeGreaterThan(-1);
    expect(transientRetryStart).toBeGreaterThan(emptyResponseStart);
    expect(terminalHandlingStart).toBeGreaterThan(transientRetryStart);

    const emptyResponseSegment = source.slice(
      emptyResponseStart,
      transientRetryStart,
    );
    const transientRetrySegment = source.slice(
      transientRetryStart,
      terminalHandlingStart,
    );

    expect(emptyResponseSegment).toContain(
      "currentInput = refreshInputOtidsForNewRequest(currentInput);",
    );
    expect(transientRetrySegment).toContain(
      "currentInput = refreshInputOtidsForNewRequest(currentInput);",
    );
  });
});
