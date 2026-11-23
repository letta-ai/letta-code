import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createAuthenticatedCliTestEnv } from "@/test-utils/test-process-env";
import {
  formatCapturedOutput,
  summarizeRecentMessages,
} from "./process-diagnostics";

const BASH_TRIGGER_PROMPT =
  "Run this exact bash command: echo test123. Do not use any other tools.";

const INTERRUPT_MESSAGE =
  "Actually, just say OK instead. Do not call any tools.";

interface StreamMessage {
  type: string;
  subtype?: string;
  message_type?: string;
  stop_reason?: string;
  request_id?: string;
  request?: { subtype?: string };
  // biome-ignore lint/suspicious/noExplicitAny: index signature for arbitrary JSON fields
  [key: string]: any;
}

async function runLazyRecoveryTest(timeoutMs = 300000): Promise<{
  messages: StreamMessage[];
  success: boolean;
  errorSeen: boolean;
}> {
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
      ],
      {
        cwd: process.cwd(),
        env: createAuthenticatedCliTestEnv(),
      },
    );

    const messages: StreamMessage[] = [];
    let buffer = "";
    let stdout = "";
    let stderr = "";
    let initReceived = false;
    let approvalSeen = false;
    let interruptSent = false;
    let errorSeen = false;
    let resultCount = 0;
    let closing = false;
    let pendingToolCallId: string | undefined;
    let promptAttempts = 0;

    const sendPrompt = () => {
      if (promptAttempts >= 3) return;
      promptAttempts++;
      const userMsg = JSON.stringify({
        type: "user",
        message: { role: "user", content: BASH_TRIGGER_PROMPT },
      });
      proc.stdin?.write(`${userMsg}\n`);
    };

    const timeout = setTimeout(() => {
      if (!closing) {
        proc.kill();
        reject(
          new Error(
            `Test timed out after ${timeoutMs}ms.\n${formatCapturedOutput({
              stdout,
              stderr,
              extra: {
                init_received: initReceived,
                approval_seen: approvalSeen,
                interrupt_sent: interruptSent,
                result_count: resultCount,
                prompt_attempts: promptAttempts,
                recent_messages: summarizeRecentMessages(
                  messages as Array<Record<string, unknown>>,
                ),
              },
            })}`,
          ),
        );
      }
    }, timeoutMs);

    let finalResult: {
      messages: StreamMessage[];
      success: boolean;
      errorSeen: boolean;
    } | null = null;
    const finish = (success: boolean) => {
      if (closing) return;
      closing = true;
      clearTimeout(timeout);
      finalResult = { messages, success, errorSeen };
      setTimeout(() => {
        proc.stdin?.end();
        proc.kill();
      }, 500);
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const msg: StreamMessage = JSON.parse(line);
        messages.push(msg);

        if (process.env.DEBUG_TEST) {
          console.log("MSG:", JSON.stringify(msg, null, 2));
        }

        if (
          msg.type === "control_request" &&
          msg.request?.subtype === "can_use_tool"
        ) {
          approvalSeen = true;
          const requestId = msg.request_id;
          if (requestId) {
            if (pendingToolCallId && !requestId.endsWith(pendingToolCallId)) {
              console.log(
                `Note: control_request id ${requestId} did not match expected tool id ${pendingToolCallId}`,
              );
            }

            if (!interruptSent) {
              interruptSent = true;
              const userMsg = JSON.stringify({
                type: "user",
                message: { role: "user", content: INTERRUPT_MESSAGE },
              });
              proc.stdin?.write(`${userMsg}\n`);
            }

            const denyApproval = JSON.stringify({
              type: "control_response",
              response: {
                request_id: requestId,
                response: {
                  behavior: "deny",
                  message:
                    "Denied by integration test to simulate stale approval",
                },
              },
            });
            proc.stdin?.write(`${denyApproval}\n`);
          }
          return;
        }

        if (msg.type === "system" && msg.subtype === "init" && !initReceived) {
          initReceived = true;
          sendPrompt();
          return;
        }

        if (
          msg.type === "message" &&
          msg.message_type === "tool_call_message" &&
          !approvalSeen
        ) {
          approvalSeen = true;

          const toolCall = Array.isArray(msg.tool_call)
            ? msg.tool_call[0]
            : msg.tool_call;
          pendingToolCallId =
            toolCall && typeof toolCall === "object"
              ? (toolCall as { tool_call_id?: string }).tool_call_id
              : undefined;

          if (!interruptSent) {
            interruptSent = true;
            const userMsg = JSON.stringify({
              type: "user",
              message: { role: "user", content: INTERRUPT_MESSAGE },
            });
            proc.stdin?.write(`${userMsg}\n`);
          }
          return;
        }

        if (
          msg.type === "recovery" &&
          msg.recovery_type === "approval_pending"
        ) {
          errorSeen = true;
        }

        if (
          msg.type === "error" ||
          (msg.type === "message" && msg.message_type === "error_message")
        ) {
          const detail = msg.detail || msg.message || "";
          if (detail.toLowerCase().includes("cannot send a new message")) {
            console.log(
              "WARNING: Raw CONFLICT error seen (recovery may have failed)",
            );
          }
        }

        if (msg.type === "result") {
          resultCount++;
          if (!approvalSeen && promptAttempts < 3) {
            sendPrompt();
            return;
          }
          if (resultCount >= 1 && !approvalSeen) {
            finish(false);
            return;
          }

          if (
            resultCount >= 1 &&
            approvalSeen &&
            (interruptSent || errorSeen)
          ) {
            finish(true);
          }
        }
      } catch {}
    };

    proc.stdout?.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        processLine(line);
      }
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (_code) => {
      clearTimeout(timeout);
      if (buffer.trim()) {
        processLine(buffer);
      }

      resolve(finalResult ?? { messages, success: resultCount > 0, errorSeen });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe("lazy approval recovery", () => {
  test("handles concurrent message while approval is pending", async () => {
    let result = await runLazyRecoveryTest();
    if (!result.success) {
      result = await runLazyRecoveryTest();
    }

    if (!result.success) {
      console.log("All messages received:");
      for (const msg of result.messages) {
        console.log(JSON.stringify(msg, null, 2));
      }
    }

    const approvalSignal = result.messages.find(
      (m) =>
        (m.type === "message" && m.message_type === "tool_call_message") ||
        (m.type === "control_request" && m.request?.subtype === "can_use_tool"),
    );
    expect(approvalSignal).toBeDefined();

    expect(result.success).toBe(true);

    const resultCount = result.messages.filter(
      (m) => m.type === "result",
    ).length;
    expect(resultCount).toBeGreaterThanOrEqual(1);

    const recoveryMessage = result.messages.find(
      (m) => m.type === "recovery" && m.recovery_type === "approval_pending",
    );
    if (recoveryMessage) {
      console.log("Recovery message detected - lazy recovery worked correctly");
      expect(result.errorSeen).toBe(true);
    } else {
      console.log(
        "Note: No recovery message seen - approval may have been handled before conflict",
      );
    }
  }, 320000);
});
