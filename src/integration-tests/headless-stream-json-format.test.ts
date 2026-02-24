import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import type {
  ResultMessage,
  StreamEvent,
  SystemInitMessage,
} from "../types/protocol";

/**
 * Tests for stream-json output format.
 * These verify the message structure matches the wire format types.
 */

async function runHeadlessCommand(
  prompt: string,
  extraArgs: string[] = [],
  timeoutMs = 180000, // 180s timeout - CI can be very slow
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "bun",
      [
        "run",
        "dev",
        "--new-agent",
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--yolo",
        "-m",
        "haiku",
        ...extraArgs,
      ],
      {
        cwd: process.cwd(),
        // Mark as subagent to prevent polluting user's LRU settings
        env: { ...process.env, LETTA_CODE_AGENT_ROLE: "subagent" },
      },
    );

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    // Safety timeout for CI
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Process timeout after ${timeoutMs}ms: ${stderr}`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !stdout.includes('"type":"result"')) {
        reject(new Error(`Process exited with code ${code}: ${stderr}`));
      } else {
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
          });
        resolve(lines);
      }
    });
  });
}

// Prescriptive prompt to ensure single-step response without tool use
const FAST_PROMPT =
  "This is a test. Do not call any tools. Just respond with the word OK and nothing else.";

describe("stream-json format", () => {
  test(
    "init message has type 'system' with subtype 'init'",
    async () => {
      const lines = await runHeadlessCommand(FAST_PROMPT);
      const initLine = lines.find((line) => {
        const obj = JSON.parse(line);
        return obj.type === "system" && obj.subtype === "init";
      });

      expect(initLine).toBeDefined();
      if (!initLine) throw new Error("initLine not found");

      const init = JSON.parse(initLine) as SystemInitMessage;
      expect(init.type).toBe("system");
      expect(init.subtype).toBe("init");
      expect(init.agent_id).toBeDefined();
      expect(init.session_id).toBe(init.agent_id); // session_id should equal agent_id
      expect(init.model).toBeDefined();
      expect(init.tools).toBeInstanceOf(Array);
      expect(init.cwd).toBeDefined();
      expect(init.uuid).toBe(`init-${init.agent_id}`);
    },
    { timeout: 200000 },
  );

  test(
    "messages have session_id and uuid",
    async () => {
      const lines = await runHeadlessCommand(FAST_PROMPT);

      // Find a message line
      const messageLine = lines.find((line) => {
        const obj = JSON.parse(line);
        return obj.type === "message";
      });

      expect(messageLine).toBeDefined();
      if (!messageLine) throw new Error("messageLine not found");

      const msg = JSON.parse(messageLine) as {
        session_id: string;
        uuid: string;
      };
      expect(msg.session_id).toBeDefined();
      expect(msg.uuid).toBeDefined();
      // uuid should be otid or id from the Letta SDK chunk
      expect(msg.uuid).toBeTruthy();
    },
    { timeout: 200000 },
  );

  test(
    "result message has correct format",
    async () => {
      const lines = await runHeadlessCommand(FAST_PROMPT);
      const resultLine = lines.find((line) => {
        const obj = JSON.parse(line);
        return obj.type === "result";
      });

      expect(resultLine).toBeDefined();
      if (!resultLine) throw new Error("resultLine not found");

      const result = JSON.parse(resultLine) as ResultMessage & { uuid: string };
      expect(result.type).toBe("result");
      expect(result.subtype).toBe("success");
      expect(result.session_id).toBeDefined();
      expect(result.agent_id).toBeDefined();
      expect(result.session_id).toBe(result.agent_id);
      expect(result.duration_ms).toBeGreaterThan(0);
      expect(result.uuid).toContain("result-");
      expect(result.result).toBeDefined();
    },
    { timeout: 200000 },
  );

  test(
    "--include-partial-messages wraps chunks in stream_event",
    async () => {
      const lines = await runHeadlessCommand(FAST_PROMPT, [
        "--include-partial-messages",
      ]);

      // Find a stream_event line
      const streamEventLine = lines.find((line) => {
        const obj = JSON.parse(line);
        return obj.type === "stream_event";
      });

      expect(streamEventLine).toBeDefined();
      if (!streamEventLine) throw new Error("streamEventLine not found");

      const event = JSON.parse(streamEventLine) as StreamEvent;
      expect(event.type).toBe("stream_event");
      expect(event.event).toBeDefined();
      expect(event.session_id).toBeDefined();
      expect(event.uuid).toBeDefined();
      // The event should contain the original Letta SDK chunk
      expect("message_type" in event.event).toBe(true);
    },
    { timeout: 200000 },
  );

  test(
    "without --include-partial-messages, messages are type 'message'",
    async () => {
      const lines = await runHeadlessCommand(FAST_PROMPT);

      // Should have message lines, not stream_event
      const messageLines = lines.filter((line) => {
        const obj = JSON.parse(line);
        return obj.type === "message";
      });

      const streamEventLines = lines.filter((line) => {
        const obj = JSON.parse(line);
        return obj.type === "stream_event";
      });

      // We should have some message lines (reasoning, assistant, stop_reason, etc.)
      // In rare cases with very fast responses, we might only get init + result
      // So check that IF we have content, it's "message" not "stream_event"
      if (messageLines.length > 0 || streamEventLines.length > 0) {
        expect(messageLines.length).toBeGreaterThan(0);
        expect(streamEventLines.length).toBe(0);
      }

      // Always should have a result
      const resultLine = lines.find((line) => {
        const obj = JSON.parse(line);
        return obj.type === "result";
      });
      expect(resultLine).toBeDefined();
    },
    { timeout: 200000 },
  );
});
