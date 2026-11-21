import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { createAuthenticatedCliTestEnv } from "@/test-utils/test-process-env";
import type {
  ControlResponse,
  ErrorMessage,
  ResultMessage,
  StreamEvent,
  SystemInitMessage,
  WireMessage,
} from "@/types/protocol";
import {
  formatAttemptDiagnostics,
  formatCapturedOutput,
  summarizeRecentMessages,
} from "./process-diagnostics";

const FAST_PROMPT =
  "This is a test. Do not call any tools. Just respond with the word OK and nothing else.";

/**
 * Helper to run bidirectional commands with stdin input.
 * Event-driven: waits for init message before sending input, waits for result before closing.
 */
async function runBidirectionalOnce(
  inputs: string[],
  extraArgs: string[] = [],
  timeoutMs = 180000, // 180s timeout - CI can be very slow
  extraEnv: NodeJS.ProcessEnv = {},
  backgroundResults = 0,
  isBackgroundComplete: (objects: object[]) => boolean = () => true,
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
        "--new-agent",
        "--memfs-startup",
        "skip",
        "-m",
        "sonnet-4.6-low",
        "--yolo",
        ...extraArgs,
      ],
      {
        cwd: process.cwd(),
        env: createAuthenticatedCliTestEnv(extraEnv),
      },
    );

    const objects: object[] = [];
    let buffer = "";
    let stdout = "";
    let inputIndex = 0;
    let initReceived = false;
    let closing = false;

    const inputTypes = inputs.map((i) => {
      try {
        const parsed = JSON.parse(i);
        return parsed.type;
      } catch {
        return "invalid"; // Invalid JSON
      }
    });
    const expectedUserResults =
      inputTypes.filter((t) => t === "user").length + backgroundResults;
    const expectedControlResponses = inputTypes.filter(
      (t) => t === "control_request",
    ).length;
    const hasInvalidInput = inputTypes.includes("invalid");

    let userResultsReceived = 0;
    let controlResponsesReceived = 0;
    let errorResponsesReceived = 0;

    const maybeClose = () => {
      if (closing) return;

      const allUserResultsDone =
        expectedUserResults === 0 || userResultsReceived >= expectedUserResults;
      const allControlResponsesDone =
        expectedControlResponses === 0 ||
        controlResponsesReceived >= expectedControlResponses;
      const allInputsSent = inputIndex >= inputs.length;

      if (
        allInputsSent &&
        allUserResultsDone &&
        allControlResponsesDone &&
        isBackgroundComplete(objects)
      ) {
        closing = true;
        setTimeout(() => proc.stdin?.end(), 500);
      }
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line);
        objects.push(obj);

        if (obj.type === "system" && obj.subtype === "init" && !initReceived) {
          initReceived = true;
          sendNextInput();
        }

        if (obj.type === "control_response") {
          controlResponsesReceived++;
          maybeClose();
        }

        if (obj.type === "result") {
          userResultsReceived++;
          // If more inputs to send, send next after a brief delay
          // This gives the CLI time to be ready for the next input
          if (inputIndex < inputs.length) {
            setTimeout(sendNextInput, 200);
          }
          maybeClose();
        }

        if (obj.type === "error" && hasInvalidInput) {
          errorResponsesReceived++;
          closing = true;
          setTimeout(() => proc.stdin?.end(), 500);
        }
      } catch {
      }
    };

    const sendNextInput = () => {
      if (inputIndex < inputs.length) {
        proc.stdin?.write(`${inputs[inputIndex]}\n`);
        inputIndex++;
      }
    };

    proc.stdout?.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      buffer += chunk;
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
      if (buffer.trim()) {
        processLine(buffer);
      }

      const gotExpectedResults =
        userResultsReceived >= expectedUserResults &&
        isBackgroundComplete(objects) &&
        controlResponsesReceived >= expectedControlResponses &&
        (!hasInvalidInput || errorResponsesReceived > 0);

      if (objects.length === 0 && code !== 0) {
        reject(
          new Error(
            `Process exited with code ${code}, no output received.\n${formatCapturedOutput(
              {
                stdout,
                stderr,
                extra: {
                  args: extraArgs.join(" "),
                  turn_inputs_and_results: JSON.stringify({
                    stdin: inputs,
                    stream: objects,
                  }),
                },
              },
            )}`,
          ),
        );
      } else if (!gotExpectedResults) {
        reject(
          new Error(
            `Process exited with code ${code} before all expected responses were received. ` +
              `Got ${userResultsReceived}/${expectedUserResults} user results, ` +
              `${controlResponsesReceived}/${expectedControlResponses} control responses, ` +
              `${errorResponsesReceived}/${hasInvalidInput ? 1 : 0} invalid-input error responses. ` +
              `inputIndex: ${inputIndex}, initReceived: ${initReceived}.\n${formatCapturedOutput(
                {
                  stdout,
                  stderr,
                  extra: {
                    args: extraArgs.join(" "),
                    turn_inputs_and_results: JSON.stringify({
                      stdin: inputs,
                      stream: objects,
                    }),
                    recent_messages: summarizeRecentMessages(
                      objects as Array<Record<string, unknown>>,
                    ),
                  },
                },
              )}`,
          ),
        );
      } else {
        resolve(objects);
      }
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(
        new Error(
          `Timeout after ${timeoutMs}ms. Received ${objects.length} objects, init: ${initReceived}, userResults: ${userResultsReceived}/${expectedUserResults}, controlResponses: ${controlResponsesReceived}/${expectedControlResponses}.\n${formatCapturedOutput(
            {
              stdout,
              stderr,
              extra: {
                args: extraArgs.join(" "),
                turn_inputs_and_results: JSON.stringify({
                  stdin: inputs,
                  stream: objects,
                }),
                recent_messages: summarizeRecentMessages(
                  objects as Array<Record<string, unknown>>,
                ),
                saw_result_event: stdout.includes('"type":"result"'),
              },
            },
          )}`,
        ),
      );
    }, timeoutMs);

    proc.on("close", () => clearTimeout(timeout));
  });
}

async function runBidirectional(
  inputs: string[],
  extraArgs: string[] = [],
  timeoutMs = 180000,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<object[]> {
  return runBidirectionalWithRetry(inputs, extraArgs, timeoutMs, 1, extraEnv);
}

async function runBidirectionalWithRetry(
  inputs: string[],
  extraArgs: string[] = [],
  timeoutMs = 180000,
  retryOnTimeouts = 1,
  extraEnv: NodeJS.ProcessEnv = {},
  backgroundResults = 0,
  isBackgroundComplete: (objects: object[]) => boolean = () => true,
): Promise<object[]> {
  let attempt = 0;
  const failedAttempts: Array<{ attempt: number; message: string }> = [];
  while (true) {
    try {
      return await runBidirectionalOnce(
        inputs,
        extraArgs,
        timeoutMs,
        extraEnv,
        backgroundResults,
        isBackgroundComplete,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedAttempts.push({
        attempt: attempt + 1,
        message,
      });
      const isRetriableError =
        error instanceof Error &&
        (error.message.includes("Timeout after") ||
          error.message.includes(
            "before all expected responses were received",
          ));
      if (!isRetriableError || attempt >= retryOnTimeouts) {
        throw new Error(
          failedAttempts.length === 1
            ? message
            : `${message}\n${formatAttemptDiagnostics(
                failedAttempts.slice(0, -1),
              )}`,
        );
      }
      attempt += 1;
      // CI API runs can occasionally exit after emitting most, but not all,
      // of the final response envelope. Retry those incomplete runs once.
      console.warn(
        `[headless-input-format] retrying after transient/incomplete run (${attempt}/${retryOnTimeouts})`,
      );
    }
  }
}

async function createSubagentReportFixture(): Promise<{
  rootDir: string;
  reportPath: string;
  expectedReport: string;
}> {
  const rootDir = await mkdtemp(join(os.tmpdir(), "letta-headless-task-"));
  await mkdir(join(rootDir, "nested"), { recursive: true });
  const reportPath = join(rootDir, "nested", "report.txt");
  // Keep the answer out of the parent prompt: only the child's file read
  // and completion notification can supply the expected report.
  const expectedReport = `SUBAGENT-REPORT-${randomUUID()}`;
  await writeFile(reportPath, `${expectedReport}\n`);

  return {
    rootDir,
    reportPath,
    expectedReport,
  };
}

describe("input-format stream-json", () => {
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

      const initEvent = objects.find(
        (o): o is SystemInitMessage =>
          o.type === "system" && "subtype" in o && o.subtype === "init",
      );
      expect(initEvent).toBeDefined();
      expect(initEvent?.agent_id).toBeDefined();
      expect(initEvent?.session_id).toBeDefined();
      expect(initEvent?.model).toBeDefined();
      expect(initEvent?.tools).toBeInstanceOf(Array);

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

      const initEvent = objects.find(
        (o): o is SystemInitMessage =>
          o.type === "system" && "subtype" in o && o.subtype === "init",
      );
      expect(initEvent).toBeDefined();

      const messageEvents = objects.filter(
        (o): o is WireMessage & { type: "message" } => o.type === "message",
      );
      expect(messageEvents.length).toBeGreaterThan(0);

      // uuid is present on content messages (reasoning, assistant) but not meta messages (stop_reason, usage_statistics)
      for (const msg of messageEvents) {
        expect(msg.session_id).toBeDefined();
      }

      const contentMessages = messageEvents.filter(
        (m) =>
          "message_type" in m &&
          (m.message_type === "reasoning_message" ||
            m.message_type === "assistant_message"),
      );
      for (const msg of contentMessages) {
        expect(msg.uuid).toBeDefined();
      }

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
      const objects = (await runBidirectionalWithRetry(
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
        1, // one retry for transient API slowness
      )) as WireMessage[];

      const results = objects.filter(
        (o): o is ResultMessage => o.type === "result",
      );
      expect(results.length).toBeGreaterThanOrEqual(2);

      for (const result of results) {
        expect(result.subtype).toBe("success");
        expect(result.session_id).toBeDefined();
        expect(result.agent_id).toBeDefined();
      }

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
      const objects = (await runBidirectionalWithRetry([
        JSON.stringify({
          type: "control_request",
          request_id: "int_1",
          request: { subtype: "interrupt" },
        }),
      ])) as WireMessage[];

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
    "recover_pending_approvals returns structured recovery payload",
    async () => {
      const objects = (await runBidirectional([
        JSON.stringify({
          type: "control_request",
          request_id: "recover_1",
          request: { subtype: "recover_pending_approvals" },
        }),
      ])) as WireMessage[];

      const controlResponse = objects.find(
        (o): o is ControlResponse =>
          o.type === "control_response" &&
          o.response?.request_id === "recover_1",
      );
      expect(controlResponse).toBeDefined();
      expect(controlResponse?.response.subtype).toBe("success");

      if (controlResponse?.response.subtype === "success") {
        const recovery = controlResponse.response.response as
          | {
              recovered?: boolean;
              pending_approval?: boolean;
              approvals_processed?: number;
            }
          | undefined;
        expect(recovery?.recovered).toBe(true);
        expect(recovery?.pending_approval).toBe(false);
        expect(recovery?.approvals_processed).toBe(0);
      }
    },
    { timeout: 200000 },
  );

  test(
    "recover_pending_approvals agent mismatch returns error response",
    async () => {
      const objects = (await runBidirectional([
        JSON.stringify({
          type: "control_request",
          request_id: "recover_mismatch_1",
          request: {
            subtype: "recover_pending_approvals",
            agent_id: "agent-mismatch",
          },
        }),
      ])) as WireMessage[];

      const controlResponse = objects.find(
        (o): o is ControlResponse =>
          o.type === "control_response" &&
          o.response?.request_id === "recover_mismatch_1",
      );
      expect(controlResponse).toBeDefined();
      expect(controlResponse?.response.subtype).toBe("error");

      if (controlResponse?.response.subtype === "error") {
        expect(controlResponse.response.error).toContain(
          "recover_pending_approvals agent mismatch",
        );
      }
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

      const streamEvents = objects.filter(
        (o): o is StreamEvent => o.type === "stream_event",
      );
      expect(streamEvents.length).toBeGreaterThan(0);

      // uuid is present on content events but not meta events (stop_reason, usage_statistics)
      for (const event of streamEvents) {
        expect(event.event).toBeDefined();
        expect(event.session_id).toBeDefined();
      }

      const contentEvents = streamEvents.filter(
        (e) =>
          "message_type" in e.event &&
          (e.event.message_type === "reasoning_message" ||
            e.event.message_type === "assistant_message"),
      );
      for (const event of contentEvents) {
        expect(event.uuid).toBeDefined();
      }

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
      const objects = (await runBidirectional([
        "not valid json",
      ])) as WireMessage[];

      const errorMsg = objects.find(
        (o): o is ErrorMessage => o.type === "error",
      );
      expect(errorMsg).toBeDefined();
      expect(errorMsg?.message).toContain("Invalid JSON");
    },
    { timeout: 200000 },
  );

  test(
    "Agent tool with general-purpose subagent works",
    async () => {
      const fixture = await createSubagentReportFixture();

      try {
        const objects = (await runBidirectionalWithRetry(
          [
            JSON.stringify({
              type: "user",
              message: {
                role: "user",
                content:
                  "Launch exactly one Agent tool with the default Letta agent (no subagent_type). " +
                  `Ask the subagent to use Read on ${JSON.stringify(fixture.reportPath)} and return the file's contents verbatim. ` +
                  "Do not read the file yourself or call any other tools. " +
                  "After the Agent tool returns, reply with exactly LAUNCHED and end your turn. " +
                  "The tool return only confirms launch; it does not contain the report. " +
                  "Do not invent a task-notification or a report, poll, or read the output file. " +
                  "On the next user-role task-notification, copy the SUBAGENT-REPORT line from its result exactly, " +
                  "even if an earlier assistant message claimed to deliver a report. " +
                  "Return only that line, with no commentary or formatting.",
              },
            }),
          ],
          // Task is the internal name of the model-facing Agent tool.
          // The child receives its own general-purpose toolset, including Read.
          ["--tools", "Task", "--base-tools", "none"],
          240000,
          1,
          { USER_CWD: fixture.rootDir },
          1,
          // Interim results must not close stdin before the child's report arrives.
          (messages) =>
            messages.some((message) => {
              const result = message as Partial<ResultMessage>;
              return (
                result.type === "result" &&
                result.result?.includes(fixture.expectedReport) === true
              );
            }),
        )) as WireMessage[];

        const results = objects.filter(
          (o): o is ResultMessage => o.type === "result",
        );
        expect(
          results.length,
          JSON.stringify(objects, null, 2),
        ).toBeGreaterThanOrEqual(2);
        const result = results
          .slice(1)
          .find((result) => result.result?.includes(fixture.expectedReport));
        expect(result).toBeDefined();
        expect(result?.subtype).toBe("success");

        // The Agent tool runs locally, so its invocation surfaces as a
        // canonical tool_call_message (approval events are no longer emitted).
        const agentToolCalls = objects.filter((o) => {
          const m = o as {
            type?: string;
            message_type?: string;
            tool_call?: { name?: string };
          };
          return (
            m.type === "message" &&
            m.message_type === "tool_call_message" &&
            m.tool_call?.name === "Agent"
          );
        });
        expect(agentToolCalls, JSON.stringify(agentToolCalls)).toHaveLength(1);
        // The parent must learn the report through the child, not Read it itself.
        expect(
          objects.filter(
            (o) =>
              o.type === "message" &&
              "message_type" in o &&
              o.message_type === "tool_call_message",
          ),
        ).toHaveLength(1);

        // Approval-flow events are stripped from stream-json output so the
        // stream matches other coding agents.
        expect(objects.some((o) => o.type === "auto_approval")).toBe(false);
        expect(
          objects.some(
            (o) =>
              o.type === "message" &&
              "message_type" in o &&
              o.message_type === "approval_request_message",
          ),
        ).toBe(false);

        expect(results[0]?.result?.trim()).toBe("LAUNCHED");
        // The report token is unique per run and only reachable through the
        // child, so finding it proves the handoff without depending on how the
        // model frames its final sentence.
        expect(result?.result).toContain(fixture.expectedReport);
      } finally {
        await rm(fixture.rootDir, { recursive: true, force: true });
      }
    },
    // Must exceed the helper timeout + retry budget, otherwise Bun can kill the
    // retry attempt before runBidirectionalWithRetry() finishes.
    { timeout: 520000 },
  );
});
