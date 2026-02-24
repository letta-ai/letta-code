import { describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

const TOOL_TRIGGER_PROMPT =
  "Use the Bash tool exactly once with command: echo test123. Do not ask clarifying questions.";
const FOLLOWUP_PROMPT = "Say OK only. Do not call tools.";

interface StreamMessage {
  type?: string;
  subtype?: string;
  message_type?: string;
  recovery_type?: string;
  conversation_id?: string;
  request?: { subtype?: string };
  [key: string]: unknown;
}

interface PendingApprovalSession {
  conversationId: string;
  stop: () => void;
  messages: StreamMessage[];
}

function parseJsonLines(text: string): StreamMessage[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as StreamMessage];
      } catch {
        return [];
      }
    });
}

async function startPendingApprovalSession(
  timeoutMs = 180000,
): Promise<PendingApprovalSession> {
  return new Promise((resolve, reject) => {
    const proc: ChildProcessWithoutNullStreams = spawn(
      "bun",
      [
        "run",
        "dev",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--new-agent",
        "--new",
        "-m",
        "haiku",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LETTA_CODE_AGENT_ROLE: "subagent" },
      },
    );

    let stdoutBuffer = "";
    let stderrBuffer = "";
    const messages: StreamMessage[] = [];

    let settled = false;
    let conversationId: string | undefined;
    let promptAttempts = 0;

    const sendPrompt = () => {
      if (promptAttempts >= 3) return;
      promptAttempts += 1;
      proc.stdin.write(
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: TOOL_TRIGGER_PROMPT },
        })}\n`,
      );
    };

    const stop = () => {
      proc.stdin.end();
      proc.kill();
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      reject(
        new Error(
          `Timed out waiting for pending approval after ${timeoutMs}ms\nSTDERR:\n${stderrBuffer}`,
        ),
      );
    }, timeoutMs);

    const complete = () => {
      if (!conversationId) {
        settled = true;
        clearTimeout(timeout);
        stop();
        reject(
          new Error(
            "Pending approval detected before conversation ID was known",
          ),
        );
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ conversationId, stop, messages });
    };

    const onMessage = (msg: StreamMessage) => {
      messages.push(msg);

      if (
        msg.type === "system" &&
        msg.subtype === "init" &&
        typeof msg.conversation_id === "string"
      ) {
        conversationId = msg.conversation_id;
        sendPrompt();
        return;
      }

      // If model responded without tool call, retry prompt up to max attempts.
      if (msg.type === "result" && promptAttempts < 3) {
        sendPrompt();
        return;
      }

      // Pending approval is active when bidirectional mode asks for permission.
      if (
        msg.type === "control_request" &&
        msg.request?.subtype === "can_use_tool"
      ) {
        complete();
      }
    };

    proc.stdout.on("data", (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        try {
          onMessage(JSON.parse(line));
        } catch {
          // Ignore non-JSON output lines
        }
      }
    });

    proc.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `Pending-approval process exited early (code=${code ?? "null"})\nSTDERR:\n${stderrBuffer}`,
        ),
      );
    });

    proc.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function runOneShotAgainstConversation(
  conversationId: string,
  timeoutMs = 180000,
): Promise<{ code: number | null; messages: StreamMessage[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "bun",
      [
        "run",
        "dev",
        "-p",
        FOLLOWUP_PROMPT,
        "--conversation",
        conversationId,
        "--output-format",
        "stream-json",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LETTA_CODE_AGENT_ROLE: "subagent" },
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(
        new Error(`Timed out waiting for one-shot run after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, messages: parseJsonLines(stdout), stderr });
    });

    proc.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}

describe("pre-stream approval recovery", () => {
  const maybeTest =
    process.env.LETTA_RUN_PRESTREAM_APPROVAL_RECOVERY_TEST === "1"
      ? test
      : test.skip;

  maybeTest(
    "recovers from pre-stream approval conflict and retries successfully",
    async () => {
      const pending = await startPendingApprovalSession();

      try {
        const result = await runOneShotAgainstConversation(
          pending.conversationId,
        );

        if (result.code !== 0) {
          throw new Error(
            `Expected one-shot run to succeed, got exit code ${result.code}\nSTDERR:\n${result.stderr}`,
          );
        }

        const recoveryEvent = result.messages.find(
          (m) =>
            m.type === "recovery" && m.recovery_type === "approval_pending",
        );
        expect(recoveryEvent).toBeDefined();

        const resultEvent = result.messages.find((m) => m.type === "result");
        expect(resultEvent).toBeDefined();
        expect(resultEvent?.subtype).toBe("success");
      } finally {
        pending.stop();
      }
    },
    240000,
  );
});
