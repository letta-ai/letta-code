import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createIsolatedCliTestEnv } from "../testProcessEnv";

const projectRoot = process.cwd();

async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const env = createIsolatedCliTestEnv({
    LETTA_DEBUG: "0",
    DISABLE_AUTOUPDATER: "1",
  });
  delete env.LETTA_API_KEY;
  delete env.LETTA_BASE_URL;
  delete env.LETTA_API_BASE;
  delete env.LETTA_AGENT_ID;
  delete env.LETTA_CONVERSATION_ID;

  return new Promise((resolve, reject) => {
    const proc = spawn("bun", ["run", "dev", ...args], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(
        new Error(
          `Timeout waiting for dev backend smoke. stdout: ${stdout}, stderr: ${stderr}`,
        ),
      );
    }, 30000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code });
    });
    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function runStreamJsonCli(): Promise<{
  objects: Array<Record<string, unknown>>;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  const env = createIsolatedCliTestEnv({
    LETTA_DEBUG: "0",
    DISABLE_AUTOUPDATER: "1",
  });
  delete env.LETTA_API_KEY;
  delete env.LETTA_BASE_URL;
  delete env.LETTA_API_BASE;
  delete env.LETTA_AGENT_ID;
  delete env.LETTA_CONVERSATION_ID;

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
        "--agent",
        "agent-fake",
        "--dev-backend",
        "fake-headless",
        "--permission-mode",
        "plan",
        "--no-skills",
      ],
      {
        cwd: projectRoot,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const objects: Array<Record<string, unknown>> = [];
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let sentInputs = false;
    let closing = false;

    const maybeClose = () => {
      const controlResponses = objects.filter(
        (obj) => obj.type === "control_response",
      ).length;
      const hasResult = objects.some((obj) => obj.type === "result");
      if (!closing && controlResponses >= 2 && hasResult) {
        closing = true;
        proc.stdin?.end();
      }
    };

    const sendInputs = () => {
      if (sentInputs) return;
      sentInputs = true;
      const inputs = [
        {
          type: "control_request",
          request_id: "bootstrap-1",
          request: { subtype: "bootstrap_session_state" },
        },
        {
          type: "control_request",
          request_id: "list-1",
          request: { subtype: "list_messages" },
        },
        {
          type: "user",
          message: { role: "user", content: "ping" },
        },
      ];
      for (const input of inputs) {
        proc.stdin?.write(`${JSON.stringify(input)}\n`);
      }
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      objects.push(parsed);
      if (parsed.type === "system" && parsed.subtype === "init") {
        sendInputs();
      }
      maybeClose();
    };

    proc.stdout?.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(
        new Error(
          `Timeout waiting for stream-json dev backend smoke. stdout: ${stdout}, stderr: ${stderr}`,
        ),
      );
    }, 30000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (buffer.trim()) {
        processLine(buffer);
      }
      resolve({ objects, stdout, stderr, exitCode: code });
    });
    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

describe("headless dev backend smoke", () => {
  test("runs one-shot headless without API credentials", async () => {
    const result = await runCli([
      "-p",
      "ping",
      "--agent",
      "agent-fake",
      "--dev-backend",
      "fake-headless",
      "--permission-mode",
      "plan",
      "--no-skills",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pong");
    expect(result.stderr).not.toContain("Missing LETTA_API_KEY");
    expect(result.stderr).not.toContain("Failed to connect to Letta server");
  });

  test("runs stream-json controls and user turn without API credentials", async () => {
    const result = await runStreamJsonCli();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Missing LETTA_API_KEY");
    expect(result.stderr).not.toContain("Failed to connect to Letta server");

    const controlResponses = result.objects.filter(
      (obj) => obj.type === "control_response",
    );
    expect(controlResponses).toHaveLength(2);
    expect(
      controlResponses.every(
        (obj) =>
          (obj.response as { subtype?: string } | undefined)?.subtype ===
          "success",
      ),
    ).toBe(true);

    expect(
      result.objects.some(
        (obj) =>
          obj.type === "message" &&
          obj.message_type === "assistant_message" &&
          JSON.stringify(obj).includes("pong"),
      ),
    ).toBe(true);
    expect(
      result.objects.some(
        (obj) => obj.type === "result" && JSON.stringify(obj).includes("pong"),
      ),
    ).toBe(true);
  });
});
