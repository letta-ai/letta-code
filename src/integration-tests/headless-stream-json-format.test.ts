import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createAuthenticatedCliTestEnv } from "@/test-utils/test-process-env";
import type {
  ResultMessage,
  StreamEvent,
  SystemInitMessage,
} from "@/types/protocol";
import {
  formatAttemptDiagnostics,
  formatCapturedOutput,
} from "./process-diagnostics";

async function runHeadlessCommandOnce(
  prompt: string,
  extraArgs: string[] = [],
  timeoutMs = 180000,
): Promise<{
  lines: string[];
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "bun",
      [
        "run",
        "dev",
        "--new-agent",
        "--memfs-startup",
        "skip",
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--yolo",
        "-m",
        "sonnet-4.6-low",
        ...extraArgs,
      ],
      {
        cwd: process.cwd(),
        env: createAuthenticatedCliTestEnv(),
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

    const timeout = setTimeout(() => {
      proc.kill();
      reject(
        new Error(
          `Process timeout after ${timeoutMs}ms.\n${formatCapturedOutput({
            stdout,
            stderr,
            extra: {
              args: extraArgs.join(" "),
              saw_result_event: stdout.includes('"type":"result"'),
            },
          })}`,
        ),
      );
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !stdout.includes('"type":"result"')) {
        reject(
          new Error(
            `Process exited with code ${code}.\n${formatCapturedOutput({
              stdout,
              stderr,
              extra: {
                args: extraArgs.join(" "),
                saw_result_event: stdout.includes('"type":"result"'),
              },
            })}`,
          ),
        );
      } else {
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
        resolve({ lines, stdout, stderr });
      }
    });
  });
}

async function runHeadlessCommand(
  prompt: string,
  extraArgs: string[] = [],
  timeoutMs = 180000,
): Promise<string[]> {
  const maxRetries = 1;
  const failedAttempts: Array<{ attempt: number; message: string }> = [];

  for (let attempt = 0; ; attempt += 1) {
    const result = await runHeadlessCommandOnce(prompt, extraArgs, timeoutMs);
    const hasResultLine = result.lines.some((line) => {
      try {
        const obj = JSON.parse(line);
        return obj.type === "result";
      } catch {
        return false;
      }
    });

    if (hasResultLine) {
      return result.lines;
    }

    failedAttempts.push({
      attempt: attempt + 1,
      message: formatCapturedOutput({
        stdout: result.stdout,
        stderr: result.stderr,
        extra: {
          args: extraArgs.join(" ") || "(none)",
          saw_result_event: result.stdout.includes('"type":"result"'),
        },
      }),
    });

    if (attempt >= maxRetries) {
      throw new Error(
        `Headless command completed without a result envelope after ${attempt + 1} attempt(s).\n${formatAttemptDiagnostics(
          failedAttempts,
        )}`,
      );
    }

    console.warn(
      `[headless-stream-json] retrying after missing result envelope (${attempt + 1}/${maxRetries})`,
    );
  }
}

const FAST_PROMPT =
  "This is a test. Do not call any tools. Just respond with the word OK and nothing else.";

const ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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
      if (!init.agent_id) throw new Error("init agent_id not found");
      expect(init.session_id).toBe(init.agent_id);
      expect(init.model).toBeDefined();
      expect(init.tools).toBeInstanceOf(Array);
      expect(init.cwd).toBeDefined();
      expect(init.uuid).toBe(`init-${init.agent_id}`);
      expect(init.timestamp).toMatch(ISO_TIMESTAMP_REGEX);
    },
    { timeout: 200000 },
  );

  test(
    "messages have session_id and uuid",
    async () => {
      const lines = await runHeadlessCommand(FAST_PROMPT);

      const messageLine = lines.find((line) => {
        const obj = JSON.parse(line);
        return obj.type === "message";
      });

      expect(messageLine).toBeDefined();
      if (!messageLine) throw new Error("messageLine not found");

      const msg = JSON.parse(messageLine) as {
        session_id: string;
        uuid: string;
        timestamp: string;
      };
      expect(msg.session_id).toBeDefined();
      expect(msg.uuid).toBeDefined();
      expect(msg.uuid).toBeTruthy();
      expect(msg.timestamp).toMatch(ISO_TIMESTAMP_REGEX);
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
      if (!result.agent_id) throw new Error("result agent_id not found");
      expect(result.session_id).toBe(result.agent_id);
      expect(result.duration_ms).toBeGreaterThan(0);
      expect(result.uuid).toContain("result-");
      expect(result.result).toBeDefined();
      expect(result.timestamp).toMatch(ISO_TIMESTAMP_REGEX);
    },
    { timeout: 200000 },
  );

  test(
    "--include-partial-messages wraps chunks in stream_event",
    async () => {
      const lines = await runHeadlessCommand(FAST_PROMPT, [
        "--include-partial-messages",
      ]);

      const streamEventLines = lines.filter((line) => {
        const obj = JSON.parse(line);
        return obj.type === "stream_event";
      });
      const messageLines = lines.filter((line) => {
        const obj = JSON.parse(line);
        return obj.type === "message";
      });

      if (streamEventLines.length > 0 || messageLines.length > 0) {
        expect(streamEventLines.length).toBeGreaterThan(0);
        expect(messageLines.length).toBe(0);
      }

      for (const line of streamEventLines) {
        const event = JSON.parse(line) as StreamEvent;
        expect(event.type).toBe("stream_event");
        expect(event.event).toBeDefined();
        expect(event.session_id).toBeDefined();
        expect(event.uuid).toBeDefined();
        expect(event.timestamp).toMatch(ISO_TIMESTAMP_REGEX);
      }

      const contentEvent = streamEventLines
        .map((line) => JSON.parse(line) as StreamEvent)
        .find((event) => "message_type" in event.event);
      if (contentEvent) {
        expect("message_type" in contentEvent.event).toBe(true);
      }

      const resultLine = lines.find((line) => {
        const obj = JSON.parse(line);
        return obj.type === "result";
      });
      expect(resultLine).toBeDefined();
    },
    { timeout: 200000 },
  );

  test(
    "without --include-partial-messages, messages are type 'message'",
    async () => {
      const lines = await runHeadlessCommand(FAST_PROMPT);

      const messageLines = lines.filter((line) => {
        const obj = JSON.parse(line);
        return obj.type === "message";
      });

      const streamEventLines = lines.filter((line) => {
        const obj = JSON.parse(line);
        return obj.type === "stream_event";
      });

      if (messageLines.length > 0 || streamEventLines.length > 0) {
        expect(messageLines.length).toBeGreaterThan(0);
        expect(streamEventLines.length).toBe(0);
      }

      const resultLine = lines.find((line) => {
        const obj = JSON.parse(line);
        return obj.type === "result";
      });
      expect(resultLine).toBeDefined();
    },
    { timeout: 200000 },
  );

  test(
    "every emitted line carries an ISO 8601 UTC timestamp",
    async () => {
      const lines = await runHeadlessCommand(FAST_PROMPT);
      expect(lines.length).toBeGreaterThan(0);

      for (const line of lines) {
        const obj = JSON.parse(line) as { type: string; timestamp?: string };
        expect(
          obj.timestamp,
          `message of type "${obj.type}" is missing a timestamp: ${line}`,
        ).toMatch(ISO_TIMESTAMP_REGEX);
      }
    },
    { timeout: 200000 },
  );
});
