import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createIsolatedCliTestEnv } from "../tests/testProcessEnv";
import type {
  ResultMessage,
  StreamEvent,
  SystemInitMessage,
} from "../types/protocol";
import {
  formatAttemptDiagnostics,
  formatCapturedOutput,
} from "./processDiagnostics";

/**
 * Tests for stream-json output format.
 * These verify the message structure matches the wire format types.
 */

async function runHeadlessCommandOnce(
  prompt: string,
  extraArgs: string[] = [],
  timeoutMs = 180000, // 180s timeout - CI can be very slow
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
        "--no-memfs",
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
        env: createIsolatedCliTestEnv(),
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

// Prescriptive prompt to ensure single-step response without tool use
const FAST_PROMPT =
  "This is a test. Do not call any tools. Just respond with the word OK and nothing else.";

// ISO 8601 UTC with ms precision + Z suffix (e.g. "2026-04-21T23:40:15.123Z").
// Matches the format emitted by new Date().toISOString() and by Claude Code / Codex.
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
      expect(init.session_id).toBe(init.agent_id); // session_id should equal agent_id
      expect(init.model).toBeDefined();
      expect(init.tools).toBeInstanceOf(Array);
      expect(init.cwd).toBeDefined();
      expect(init.uuid).toBe(`init-${init.agent_id}`);
      // Every emitted wire line must carry an ISO 8601 UTC timestamp.
      expect(init.timestamp).toMatch(ISO_TIMESTAMP_REGEX);
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
        timestamp: string;
      };
      expect(msg.session_id).toBeDefined();
      expect(msg.uuid).toBeDefined();
      // uuid should be otid or id from the Letta SDK chunk
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
      expect(result.session_id).toBe(result.agent_id);
      expect(result.duration_ms).toBeGreaterThan(0);
      expect(result.uuid).toContain("result-");
      expect(result.result).toBeDefined();
      // Result lines must also carry a wall-clock timestamp in addition
      // to duration_ms (which is measured from turn start).
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

      // In rare fast-response cases, the stream may emit only init + result and
      // never surface partial chunks. If any streamed chunk payloads exist, they
      // must be wrapped as stream_event rather than plain message lines.
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

  test(
    "every emitted line carries an ISO 8601 UTC timestamp",
    async () => {
      // Regression guard: if a new emit site is added in headless.ts that
      // bypasses writeWireMessage, this test will catch it.
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

  // Prompt that forces a local tool call. The model must Read the file,
  // which auto-approves and executes locally — giving us a tool_return_message
  // that would otherwise never reach the wire.
  const TOOL_PROMPT =
    "Read the file README.md using the Read tool, then tell me how many lines it has. Do not use any other tools.";

  test(
    "tool_return_message is emitted on the wire after local tool execution",
    async () => {
      const lines = await runHeadlessCommand(TOOL_PROMPT);

      const toolReturns = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter(
          (o) =>
            o.type === "message" && o.message_type === "tool_return_message",
        );

      expect(toolReturns.length).toBeGreaterThan(0);

      const first = toolReturns[0] as {
        tool_call_id: string;
        tool_return: unknown;
        status: string;
        timestamp: string;
        uuid: string;
        session_id: string;
        agent_id: string;
        conversation_id: string;
      };

      expect(typeof first.tool_call_id).toBe("string");
      expect(first.tool_call_id.length).toBeGreaterThan(0);
      expect(typeof first.tool_return).toBe("string");
      expect(["success", "error"]).toContain(first.status);
      expect(first.timestamp).toMatch(ISO_TIMESTAMP_REGEX);
      expect(first.uuid).toBe(`tool-return-${first.tool_call_id}`);
      expect(first.session_id).toBe(first.agent_id);
      expect(first.conversation_id).toBeTruthy();
    },
    { timeout: 200000 },
  );

  test(
    "tool_return_message arrives between approval and next assistant_message",
    async () => {
      const lines = await runHeadlessCommand(TOOL_PROMPT);

      // Extract the sequence of message_type (or top-level type when no message_type).
      const kinds = lines.map((l) => {
        const o = JSON.parse(l) as {
          type: string;
          message_type?: string;
        };
        return o.message_type ?? o.type;
      });

      const approvalIdx = kinds.findIndex(
        (k) => k === "approval_request_message" || k === "tool_call_message",
      );
      const toolReturnIdx = kinds.indexOf("tool_return_message");
      // Find the last assistant_message (the model's final summary after the tool).
      const lastAssistantIdx = kinds.lastIndexOf("assistant_message");

      expect(approvalIdx).toBeGreaterThan(-1);
      expect(toolReturnIdx).toBeGreaterThan(approvalIdx);
      expect(lastAssistantIdx).toBeGreaterThan(toolReturnIdx);
    },
    { timeout: 200000 },
  );

  test(
    "assistant_message arrives as one complete event per otid in default mode",
    async () => {
      // Default (coalesced) mode: each logical message surfaces as exactly
      // one event. In partial mode (below) the same otid produces many.
      const lines = await runHeadlessCommand(FAST_PROMPT);

      const assistantLines = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter(
          (o) => o.type === "message" && o.message_type === "assistant_message",
        );

      expect(assistantLines.length).toBeGreaterThan(0);

      // Group by otid — each otid should appear exactly once.
      const perOtid = new Map<string, number>();
      for (const msg of assistantLines) {
        const otid = String(msg.otid ?? msg.id ?? "");
        perOtid.set(otid, (perOtid.get(otid) ?? 0) + 1);
      }
      for (const [otid, count] of perOtid) {
        expect(count, `assistant_message otid "${otid}" fragmented`).toBe(1);
      }

      // And at least one assistant message should carry non-trivial text.
      const hasText = assistantLines.some((msg) => {
        const content = msg.content;
        if (typeof content === "string") return content.trim().length > 0;
        if (Array.isArray(content)) {
          return content.some((part) => {
            const p = part as { text?: unknown };
            return typeof p?.text === "string" && p.text.trim().length > 0;
          });
        }
        return false;
      });
      expect(hasText).toBe(true);
    },
    { timeout: 200000 },
  );

  test(
    "tool_call arguments are complete valid JSON in default mode",
    async () => {
      // With coalescing, the approval_request_message on the wire carries a
      // complete `arguments` string — parseable as JSON, not a fragment.
      const lines = await runHeadlessCommand(TOOL_PROMPT);

      const approvalMessages = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter(
          (o) =>
            o.type === "message" &&
            (o.message_type === "approval_request_message" ||
              o.message_type === "tool_call_message"),
        );

      expect(approvalMessages.length).toBeGreaterThan(0);

      // Each approval/tool-call message should appear once per tool_call_id.
      const perToolCall = new Map<string, number>();
      for (const msg of approvalMessages) {
        const toolCall = msg.tool_call as { tool_call_id?: string };
        const id = toolCall?.tool_call_id;
        expect(id).toBeTruthy();
        if (!id) continue;
        perToolCall.set(id, (perToolCall.get(id) ?? 0) + 1);

        // `arguments` must be a non-empty JSON-parseable string.
        const args = (toolCall as { arguments?: unknown }).arguments;
        expect(typeof args).toBe("string");
        expect(String(args).length).toBeGreaterThan(0);
        expect(() => JSON.parse(String(args))).not.toThrow();
      }
      for (const [id, count] of perToolCall) {
        expect(count, `tool_call_id "${id}" fragmented`).toBe(1);
      }
    },
    { timeout: 200000 },
  );

  test(
    "step_end event is emitted for each approval step and for end_turn",
    async () => {
      // Each server step terminates with a single `step_end` wire event
      // carrying `stop_reason`, `step_id`, and `usage`. Content messages
      // never carry step metadata inline.
      const lines = await runHeadlessCommand(TOOL_PROMPT);
      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);

      const stepEndEvents = parsed.filter((o) => o.type === "step_end");
      expect(stepEndEvents.length).toBeGreaterThanOrEqual(2);

      // At least one approval step.
      const approvalStepEnd = stepEndEvents.find(
        (o) => o.stop_reason === "requires_approval",
      );
      expect(approvalStepEnd).toBeDefined();
      if (!approvalStepEnd) throw new Error("no approval step_end");
      expect(typeof approvalStepEnd.step_id).toBe("string");
      expect(approvalStepEnd.usage).toBeDefined();
      const approvalUsage = approvalStepEnd.usage as Record<string, unknown>;
      expect(typeof approvalUsage.total_tokens).toBe("number");
      expect(typeof approvalUsage.prompt_tokens).toBe("number");
      expect(typeof approvalUsage.completion_tokens).toBe("number");

      // And exactly one end_turn step at the tail.
      const endTurnStepEnd = stepEndEvents.find(
        (o) => o.stop_reason === "end_turn",
      );
      expect(endTurnStepEnd).toBeDefined();
      if (!endTurnStepEnd) throw new Error("no end_turn step_end");
      expect(typeof endTurnStepEnd.step_id).toBe("string");
      expect(endTurnStepEnd.usage).toBeDefined();
    },
    { timeout: 200000 },
  );

  test(
    "content messages never carry stop_reason or usage inline",
    async () => {
      // Regression guard: the previous design merged step terminators onto
      // the last content message in each step. That's gone — content stays
      // clean, terminators live on the `step_end` event.
      const lines = await runHeadlessCommand(TOOL_PROMPT);
      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);

      const contentMsgs = parsed.filter(
        (o) =>
          o.type === "message" &&
          (o.message_type === "assistant_message" ||
            o.message_type === "reasoning_message" ||
            o.message_type === "approval_request_message" ||
            o.message_type === "tool_call_message"),
      );
      expect(contentMsgs.length).toBeGreaterThan(0);
      for (const msg of contentMsgs) {
        expect(msg.stop_reason).toBeUndefined();
        expect(msg.usage).toBeUndefined();
      }

      // And no standalone stop_reason / usage_statistics messages either —
      // those are subsumed by `step_end`.
      const standaloneStopReason = parsed.filter(
        (o) => o.type === "message" && o.message_type === "stop_reason",
      );
      const standaloneUsage = parsed.filter(
        (o) => o.type === "message" && o.message_type === "usage_statistics",
      );
      expect(standaloneStopReason).toHaveLength(0);
      expect(standaloneUsage).toHaveLength(0);
    },
    { timeout: 200000 },
  );

  test(
    "--include-partial-messages yields multiple delta events per otid",
    async () => {
      // In passthrough mode the aggregator is bypassed; assistant_message
      // deltas surface as multiple stream_event lines per otid.
      const lines = await runHeadlessCommand(FAST_PROMPT, [
        "--include-partial-messages",
      ]);

      const assistantEvents = lines
        .map((l) => JSON.parse(l) as { type: string; event?: unknown })
        .filter(
          (o) =>
            o.type === "stream_event" &&
            typeof o.event === "object" &&
            o.event !== null &&
            (o.event as { message_type?: string }).message_type ===
              "assistant_message",
        );

      // Fast prompts sometimes collapse to a single delta. Where we do see
      // more than one assistant chunk, some otid should have >1 event.
      if (assistantEvents.length > 1) {
        const perOtid = new Map<string, number>();
        for (const ev of assistantEvents) {
          const event = ev.event as { otid?: string; id?: string };
          const otid = String(event.otid ?? event.id ?? "");
          perOtid.set(otid, (perOtid.get(otid) ?? 0) + 1);
        }
        const hasFragmented = Array.from(perOtid.values()).some((n) => n > 1);
        expect(
          hasFragmented,
          "passthrough mode should produce multiple deltas per otid",
        ).toBe(true);
      }
    },
    { timeout: 200000 },
  );

  test(
    "no emitted line carries a `date` field (regression guard for #8)",
    async () => {
      // The server includes `date` (second-precision, +00:00 format) on some
      // messages; `timestamp` (ms, Z) is the canonical time source on the
      // wire. PR 2 drops `date` from every emission.
      const lines = await runHeadlessCommand(TOOL_PROMPT);
      expect(lines.length).toBeGreaterThan(0);

      for (const line of lines) {
        const obj = JSON.parse(line) as Record<string, unknown>;
        expect(obj).not.toHaveProperty("date");
      }
    },
    { timeout: 200000 },
  );
});
