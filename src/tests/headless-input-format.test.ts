import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";

/**
 * Tests for --input-format stream-json bidirectional communication.
 * These verify the SDK can communicate with the CLI via stdin/stdout.
 */

// Prescriptive prompt to ensure single-step response without tool use
const FAST_PROMPT =
  "This is a test. Do not call any tools. Just respond with the word OK and nothing else.";

/**
 * Helper to run bidirectional commands with stdin input.
 * Sends input lines, waits for output, and returns parsed JSON lines.
 */
async function runBidirectional(
  inputs: string[],
  extraArgs: string[] = [],
  waitMs = 5000,
): Promise<object[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "bun",
      [
        "run",
        "dev",
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--new",
        "-m",
        "haiku",
        "--yolo",
        ...extraArgs,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env },
      },
    );

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    // Write inputs with delays between them
    let inputIndex = 0;
    const writeNextInput = () => {
      if (inputIndex < inputs.length) {
        proc.stdin?.write(inputs[inputIndex] + "\n");
        inputIndex++;
        setTimeout(writeNextInput, 500);
      } else {
        // All inputs sent, wait for processing then close
        setTimeout(() => {
          proc.stdin?.end();
        }, waitMs);
      }
    };

    // Start writing inputs after a small delay for process to initialize
    setTimeout(writeNextInput, 1000);

    proc.on("close", (code) => {
      // Parse line-delimited JSON
      const lines = stdout
        .split("\n")
        .filter((line) => line.trim())
        .filter((line) => {
          try {
            JSON.parse(line);
            return true;
          } catch {
            return false;
          }
        })
        .map((line) => JSON.parse(line));

      if (lines.length === 0 && code !== 0) {
        reject(new Error(`Process exited with code ${code}: ${stderr}`));
      } else {
        resolve(lines);
      }
    });

    // Safety timeout
    setTimeout(
      () => {
        proc.kill();
      },
      waitMs + 5000 + inputs.length * 1000,
    );
  });
}

describe("input-format stream-json", () => {
  test(
    "initialize control request returns session info",
    async () => {
      const objects = await runBidirectional([
        JSON.stringify({
          type: "control_request",
          request_id: "init_1",
          request: { subtype: "initialize" },
        }),
      ]);

      // Should have init event
      const initEvent = objects.find(
        (o: any) => o.type === "system" && o.subtype === "init",
      );
      expect(initEvent).toBeDefined();
      expect((initEvent as any).agent_id).toBeDefined();
      expect((initEvent as any).session_id).toBeDefined();
      expect((initEvent as any).model).toBeDefined();
      expect((initEvent as any).tools).toBeInstanceOf(Array);

      // Should have control_response
      const controlResponse = objects.find(
        (o: any) => o.type === "control_response",
      );
      expect(controlResponse).toBeDefined();
      expect((controlResponse as any).response.subtype).toBe("success");
      expect((controlResponse as any).response.request_id).toBe("init_1");
      expect((controlResponse as any).response.response.agent_id).toBeDefined();
    },
    { timeout: 30000 },
  );

  test(
    "user message returns assistant response and result",
    async () => {
      const objects = await runBidirectional(
        [
          JSON.stringify({
            type: "user",
            message: { role: "user", content: FAST_PROMPT },
          }),
        ],
        [],
        10000,
      );

      // Should have init event
      const initEvent = objects.find(
        (o: any) => o.type === "system" && o.subtype === "init",
      );
      expect(initEvent).toBeDefined();

      // Should have message events
      const messageEvents = objects.filter((o: any) => o.type === "message");
      expect(messageEvents.length).toBeGreaterThan(0);

      // All messages should have session_id
      // uuid is present on content messages (reasoning, assistant) but not meta messages (stop_reason, usage_statistics)
      for (const msg of messageEvents) {
        expect((msg as any).session_id).toBeDefined();
      }

      // Content messages should have uuid
      const contentMessages = messageEvents.filter(
        (m: any) =>
          m.message_type === "reasoning_message" ||
          m.message_type === "assistant_message",
      );
      for (const msg of contentMessages) {
        expect((msg as any).uuid).toBeDefined();
      }

      // Should have result
      const result = objects.find((o: any) => o.type === "result");
      expect(result).toBeDefined();
      expect((result as any).subtype).toBe("success");
      expect((result as any).session_id).toBeDefined();
      expect((result as any).agent_id).toBeDefined();
      expect((result as any).duration_ms).toBeGreaterThan(0);
    },
    { timeout: 60000 },
  );

  test(
    "multi-turn conversation maintains context",
    async () => {
      const objects = await runBidirectional(
        [
          JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content:
                "Remember this exact code: APPLE123. Respond only with: OK",
            },
          }),
          JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content:
                "What was the exact code I told you to remember? Respond with ONLY the code, nothing else.",
            },
          }),
        ],
        [],
        20000,
      );

      // Should have at least two results (one per turn)
      const results = objects.filter((o: any) => o.type === "result");
      expect(results.length).toBeGreaterThanOrEqual(2);

      // The second result should contain the secret code
      const lastResult = results[results.length - 1] as any;
      expect(lastResult.subtype).toBe("success");
      // Check that the response contains APPLE123 (case-insensitive, allowing for surrounding text)
      expect(lastResult.result.toUpperCase()).toMatch(/APPLE\s*123/);
    },
    { timeout: 120000 },
  );

  test(
    "interrupt control request is acknowledged",
    async () => {
      const objects = await runBidirectional([
        JSON.stringify({
          type: "control_request",
          request_id: "int_1",
          request: { subtype: "interrupt" },
        }),
      ]);

      // Should have control_response for interrupt
      const controlResponse = objects.find(
        (o: any) =>
          o.type === "control_response" && o.response?.request_id === "int_1",
      );
      expect(controlResponse).toBeDefined();
      expect((controlResponse as any).response.subtype).toBe("success");
    },
    { timeout: 30000 },
  );

  test(
    "--include-partial-messages emits stream_event in bidirectional mode",
    async () => {
      const objects = await runBidirectional(
        [
          JSON.stringify({
            type: "user",
            message: { role: "user", content: FAST_PROMPT },
          }),
        ],
        ["--include-partial-messages"],
        10000,
      );

      // Should have stream_event messages (not just "message" type)
      const streamEvents = objects.filter(
        (o: any) => o.type === "stream_event",
      );
      expect(streamEvents.length).toBeGreaterThan(0);

      // Each stream_event should have the event payload and session_id
      // uuid is present on content events but not meta events (stop_reason, usage_statistics)
      for (const event of streamEvents) {
        expect((event as any).event).toBeDefined();
        expect((event as any).session_id).toBeDefined();
      }

      // Content events should have uuid
      const contentEvents = streamEvents.filter(
        (e: any) =>
          e.event?.message_type === "reasoning_message" ||
          e.event?.message_type === "assistant_message",
      );
      for (const event of contentEvents) {
        expect((event as any).uuid).toBeDefined();
      }

      // Should still have result
      const result = objects.find((o: any) => o.type === "result");
      expect(result).toBeDefined();
      expect((result as any).subtype).toBe("success");
    },
    { timeout: 60000 },
  );

  test(
    "unknown control request returns error",
    async () => {
      const objects = await runBidirectional([
        JSON.stringify({
          type: "control_request",
          request_id: "unknown_1",
          request: { subtype: "unknown_subtype" },
        }),
      ]);

      // Should have control_response with error
      const controlResponse = objects.find(
        (o: any) =>
          o.type === "control_response" &&
          o.response?.request_id === "unknown_1",
      );
      expect(controlResponse).toBeDefined();
      expect((controlResponse as any).response.subtype).toBe("error");
    },
    { timeout: 30000 },
  );

  test(
    "invalid JSON input returns error message",
    async () => {
      // Use raw string instead of JSON
      const objects = await runBidirectional(["not valid json"]);

      // Should have error message
      const errorMsg = objects.find((o: any) => o.type === "error");
      expect(errorMsg).toBeDefined();
      expect((errorMsg as any).message).toContain("Invalid JSON");
    },
    { timeout: 30000 },
  );
});
