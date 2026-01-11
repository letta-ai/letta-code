import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import type {
  ControlResponse,
  ErrorMessage,
  ResultMessage,
  StreamEvent,
  SystemInitMessage,
  WireMessage,
} from "../types/protocol";

/**
 * Tests for --input-format stream-json bidirectional communication.
 * These verify the CLI's wire format for bidirectional communication.
 */

// Prescriptive prompt to ensure single-step response without tool use
const FAST_PROMPT =
  "This is a test. Do not call any tools. Just respond with the word OK and nothing else.";

/**
 * Helper to run bidirectional commands with stdin input.
 * Event-driven: waits for init message before sending input, waits for result before closing.
 */
async function runBidirectional(
  inputs: string[],
  extraArgs: string[] = [],
  timeoutMs = 180000, // 180s timeout - CI can be very slow
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

    const objects: object[] = [];
    let buffer = "";
    let inputIndex = 0;
    let initReceived = false;
    let closing = false;

    // Count expected responses based on input types
    const inputTypes = inputs.map((i) => {
      try {
        const parsed = JSON.parse(i);
        return parsed.type;
      } catch {
        return "invalid"; // Invalid JSON
      }
    });
    const expectedUserResults = inputTypes.filter((t) => t === "user").length;
    const expectedControlResponses = inputTypes.filter(
      (t) => t === "control_request",
    ).length;
    const hasInvalidInput = inputTypes.includes("invalid");

    let userResultsReceived = 0;
    let controlResponsesReceived = 0;

    const maybeClose = () => {
      if (closing) return;

      // For invalid input, close after receiving error
      // For control requests only, close after all control_responses
      // For user messages, close after all results
      // For mixed, close when we have all expected responses

      const allUserResultsDone =
        expectedUserResults === 0 || userResultsReceived >= expectedUserResults;
      const allControlResponsesDone =
        expectedControlResponses === 0 ||
        controlResponsesReceived >= expectedControlResponses;
      const allInputsSent = inputIndex >= inputs.length;

      if (allInputsSent && allUserResultsDone && allControlResponsesDone) {
        closing = true;
        setTimeout(() => proc.stdin?.end(), 500);
      }
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line);
        objects.push(obj);

        // Check for init message - signal to start sending inputs
        if (obj.type === "system" && obj.subtype === "init" && !initReceived) {
          initReceived = true;
          sendNextInput();
        }

        // Check for control_response
        if (obj.type === "control_response") {
          controlResponsesReceived++;
          maybeClose();
        }

        // Check for result message
        if (obj.type === "result") {
          userResultsReceived++;
          // If more inputs to send, send next after a brief delay
          // This gives the CLI time to be ready for the next input
          if (inputIndex < inputs.length) {
            setTimeout(sendNextInput, 200);
          }
          // Always check if we should close (might have received all expected results)
          maybeClose();
        }

        // Check for error message (for invalid JSON input test)
        if (obj.type === "error" && hasInvalidInput) {
          closing = true;
          setTimeout(() => proc.stdin?.end(), 500);
        }
      } catch {
        // Not valid JSON, ignore
      }
    };

    const sendNextInput = () => {
      if (inputIndex < inputs.length) {
        proc.stdin?.write(`${inputs[inputIndex]}\n`);
        inputIndex++;
      }
    };

    proc.stdout?.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer
      for (const line of lines) {
        processLine(line);
      }
    });

    let stderr = "";
    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      // Process any remaining buffer
      if (buffer.trim()) {
        processLine(buffer);
      }

      // Check if we got enough results
      const gotExpectedResults =
        userResultsReceived >= expectedUserResults &&
        controlResponsesReceived >= expectedControlResponses;

      if (objects.length === 0 && code !== 0) {
        reject(
          new Error(
            `Process exited with code ${code}, no output received. stderr: ${stderr}`,
          ),
        );
      } else if (!gotExpectedResults && code !== 0) {
        reject(
          new Error(
            `Process exited with code ${code} before all results received. ` +
              `Got ${userResultsReceived}/${expectedUserResults} user results, ` +
              `${controlResponsesReceived}/${expectedControlResponses} control responses. ` +
              `inputIndex: ${inputIndex}, initReceived: ${initReceived}. stderr: ${stderr}`,
          ),
        );
      } else {
        resolve(objects);
      }
    });

    // Safety timeout
    const timeout = setTimeout(() => {
      proc.kill();
      reject(
        new Error(
          `Timeout after ${timeoutMs}ms. Received ${objects.length} objects, init: ${initReceived}, userResults: ${userResultsReceived}/${expectedUserResults}, controlResponses: ${controlResponsesReceived}/${expectedControlResponses}`,
        ),
      );
    }, timeoutMs);

    proc.on("close", () => clearTimeout(timeout));
  });
}

describe.skipIf(!process.env.LETTA_API_KEY)("input-format stream-json", () => {
  test(
    "initialize control request returns session info",
    async () => {
      const objects = (await runBidirectional([
        JSON.stringify({
          type: "control_request",
          request_id: "init_1",
          request: { subtype: "initialize" },
        }),
      ])) as WireMessage[];

      // Should have init event
      const initEvent = objects.find(
        (o): o is SystemInitMessage =>
          o.type === "system" && "subtype" in o && o.subtype === "init",
      );
      expect(initEvent).toBeDefined();
      expect(initEvent?.agent_id).toBeDefined();
      expect(initEvent?.session_id).toBeDefined();
      expect(initEvent?.model).toBeDefined();
      expect(initEvent?.tools).toBeInstanceOf(Array);

      // Should have control_response
      const controlResponse = objects.find(
        (o): o is ControlResponse => o.type === "control_response",
      );
      expect(controlResponse).toBeDefined();
      expect(controlResponse?.response.subtype).toBe("success");
      expect(controlResponse?.response.request_id).toBe("init_1");
      if (controlResponse?.response.subtype === "success") {
        const initResponse = controlResponse.response.response as
          | { agent_id?: string }
          | undefined;
        expect(initResponse?.agent_id).toBeDefined();
      }
    },
    { timeout: 200000 },
  );

  test(
    "user message returns assistant response and result",
    async () => {
      const objects = (await runBidirectional([
        JSON.stringify({
          type: "user",
          message: { role: "user", content: FAST_PROMPT },
        }),
      ])) as WireMessage[];

      // Should have init event
      const initEvent = objects.find(
        (o): o is SystemInitMessage =>
          o.type === "system" && "subtype" in o && o.subtype === "init",
      );
      expect(initEvent).toBeDefined();

      // Should have message events
      const messageEvents = objects.filter(
        (o): o is WireMessage & { type: "message" } => o.type === "message",
      );
      expect(messageEvents.length).toBeGreaterThan(0);

      // All messages should have session_id
      // uuid is present on content messages (reasoning, assistant) but not meta messages (stop_reason, usage_statistics)
      for (const msg of messageEvents) {
        expect(msg.session_id).toBeDefined();
      }

      // Content messages should have uuid
      const contentMessages = messageEvents.filter(
        (m) =>
          "message_type" in m &&
          (m.message_type === "reasoning_message" ||
            m.message_type === "assistant_message"),
      );
      for (const msg of contentMessages) {
        expect(msg.uuid).toBeDefined();
      }

      // Should have result
      const result = objects.find(
        (o): o is ResultMessage => o.type === "result",
      );
      expect(result).toBeDefined();
      expect(result?.subtype).toBe("success");
      expect(result?.session_id).toBeDefined();
      expect(result?.agent_id).toBeDefined();
      expect(result?.duration_ms).toBeGreaterThan(0);
    },
    { timeout: 200000 },
  );

  test(
    "multi-turn conversation maintains context",
    async () => {
      // Multi-turn test needs 2 sequential LLM calls, so allow more time
      const objects = (await runBidirectional(
        [
          JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content: "Say hello",
            },
          }),
          JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content: "Say goodbye",
            },
          }),
        ],
        [], // no extra args
        300000, // 300s for 2 sequential LLM calls - CI can be very slow
      )) as WireMessage[];

      // Should have at least two results (one per turn)
      const results = objects.filter(
        (o): o is ResultMessage => o.type === "result",
      );
      expect(results.length).toBeGreaterThanOrEqual(2);

      // Both results should be successful
      for (const result of results) {
        expect(result.subtype).toBe("success");
        expect(result.session_id).toBeDefined();
        expect(result.agent_id).toBeDefined();
      }

      // The session_id should be consistent across turns (same agent)
      const firstResult = results[0];
      const lastResult = results[results.length - 1];
      expect(firstResult).toBeDefined();
      expect(lastResult).toBeDefined();
      if (firstResult && lastResult) {
        expect(firstResult.session_id).toBe(lastResult.session_id);
      }
    },
    { timeout: 320000 },
  );

  test(
    "interrupt control request is acknowledged",
    async () => {
      const objects = (await runBidirectional([
        JSON.stringify({
          type: "control_request",
          request_id: "int_1",
          request: { subtype: "interrupt" },
        }),
      ])) as WireMessage[];

      // Should have control_response for interrupt
      const controlResponse = objects.find(
        (o): o is ControlResponse =>
          o.type === "control_response" && o.response?.request_id === "int_1",
      );
      expect(controlResponse).toBeDefined();
      expect(controlResponse?.response.subtype).toBe("success");
    },
    { timeout: 200000 },
  );

  test(
    "--include-partial-messages emits stream_event in bidirectional mode",
    async () => {
      const objects = (await runBidirectional(
        [
          JSON.stringify({
            type: "user",
            message: { role: "user", content: FAST_PROMPT },
          }),
        ],
        ["--include-partial-messages"],
      )) as WireMessage[];

      // Should have stream_event messages (not just "message" type)
      const streamEvents = objects.filter(
        (o): o is StreamEvent => o.type === "stream_event",
      );
      expect(streamEvents.length).toBeGreaterThan(0);

      // Each stream_event should have the event payload and session_id
      // uuid is present on content events but not meta events (stop_reason, usage_statistics)
      for (const event of streamEvents) {
        expect(event.event).toBeDefined();
        expect(event.session_id).toBeDefined();
      }

      // Content events should have uuid
      const contentEvents = streamEvents.filter(
        (e) =>
          "message_type" in e.event &&
          (e.event.message_type === "reasoning_message" ||
            e.event.message_type === "assistant_message"),
      );
      for (const event of contentEvents) {
        expect(event.uuid).toBeDefined();
      }

      // Should still have result
      const result = objects.find(
        (o): o is ResultMessage => o.type === "result",
      );
      expect(result).toBeDefined();
      expect(result?.subtype).toBe("success");
    },
    { timeout: 200000 },
  );

  test(
    "unknown control request returns error",
    async () => {
      const objects = (await runBidirectional([
        JSON.stringify({
          type: "control_request",
          request_id: "unknown_1",
          request: { subtype: "unknown_subtype" },
        }),
      ])) as WireMessage[];

      // Should have control_response with error
      const controlResponse = objects.find(
        (o): o is ControlResponse =>
          o.type === "control_response" &&
          o.response?.request_id === "unknown_1",
      );
      expect(controlResponse).toBeDefined();
      expect(controlResponse?.response.subtype).toBe("error");
    },
    { timeout: 200000 },
  );

  test(
    "invalid JSON input returns error message",
    async () => {
      // Use raw string instead of JSON
      const objects = (await runBidirectional([
        "not valid json",
      ])) as WireMessage[];

      // Should have error message
      const errorMsg = objects.find(
        (o): o is ErrorMessage => o.type === "error",
      );
      expect(errorMsg).toBeDefined();
      expect(errorMsg?.message).toContain("Invalid JSON");
    },
    { timeout: 200000 },
  );
});
