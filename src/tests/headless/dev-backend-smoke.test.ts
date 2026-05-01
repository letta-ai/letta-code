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
    let sentInitialInputs = false;
    let sentListAfterFirstTurn = false;
    let sentSecondTurn = false;
    let sentFinalControls = false;
    let closing = false;
    let resultCount = 0;
    const controlResponseIds = new Set<string>();

    const maybeClose = () => {
      const hasAllControlResponses = [
        "bootstrap-initial",
        "list-after-1",
        "bootstrap-after-2",
        "list-after-2",
      ].every((id) => controlResponseIds.has(id));
      if (!closing && resultCount >= 2 && hasAllControlResponses) {
        closing = true;
        proc.stdin?.end();
      }
    };

    const sendInput = (input: Record<string, unknown>) => {
      proc.stdin?.write(`${JSON.stringify(input)}\n`);
    };

    const sendInitialInputs = () => {
      if (sentInitialInputs) return;
      sentInitialInputs = true;
      sendInput({
        type: "control_request",
        request_id: "bootstrap-initial",
        request: { subtype: "bootstrap_session_state" },
      });
      sendInput({
        type: "user",
        message: { role: "user", content: "ping one" },
      });
    };

    const sendListAfterFirstTurn = () => {
      if (sentListAfterFirstTurn) return;
      sentListAfterFirstTurn = true;
      sendInput({
        type: "control_request",
        request_id: "list-after-1",
        request: { subtype: "list_messages" },
      });
    };

    const sendSecondTurn = () => {
      if (sentSecondTurn) return;
      sentSecondTurn = true;
      sendInput({
        type: "user",
        message: { role: "user", content: "ping two" },
      });
    };

    const sendFinalControls = () => {
      if (sentFinalControls) return;
      sentFinalControls = true;
      sendInput({
        type: "control_request",
        request_id: "bootstrap-after-2",
        request: { subtype: "bootstrap_session_state" },
      });
      sendInput({
        type: "control_request",
        request_id: "list-after-2",
        request: { subtype: "list_messages" },
      });
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
        sendInitialInputs();
      }
      if (parsed.type === "result") {
        resultCount += 1;
        if (resultCount === 1) {
          sendListAfterFirstTurn();
        } else if (resultCount === 2) {
          sendFinalControls();
        }
      }
      if (parsed.type === "control_response") {
        const response = parsed.response as
          | { request_id?: unknown; subtype?: unknown }
          | undefined;
        if (typeof response?.request_id === "string") {
          controlResponseIds.add(response.request_id);
          if (response.request_id === "list-after-1") {
            sendSecondTurn();
          }
        }
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

async function runStreamJsonToolCli(): Promise<{
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
        "fake-headless-tool-call",
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
    let sentUser = false;
    let sentList = false;
    let closing = false;

    const sendInput = (input: Record<string, unknown>) => {
      proc.stdin?.write(`${JSON.stringify(input)}\n`);
    };

    const maybeClose = () => {
      const hasResult = objects.some((obj) => obj.type === "result");
      const hasList = objects.some((obj) => {
        if (obj.type !== "control_response") return false;
        const response = obj.response as { request_id?: unknown } | undefined;
        return response?.request_id === "list-after-tool";
      });
      if (!closing && hasResult && hasList) {
        closing = true;
        proc.stdin?.end();
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
      if (parsed.type === "system" && parsed.subtype === "init" && !sentUser) {
        sentUser = true;
        sendInput({
          type: "user",
          message: {
            role: "user",
            content: "please use the deterministic tool",
          },
        });
      }
      if (parsed.type === "result" && !sentList) {
        sentList = true;
        sendInput({
          type: "control_request",
          request_id: "list-after-tool",
          request: { subtype: "list_messages" },
        });
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
          `Timeout waiting for stream-json tool dev backend smoke. stdout: ${stdout}, stderr: ${stderr}`,
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

function findControlPayload(
  objects: Array<Record<string, unknown>>,
  requestId: string,
): Record<string, unknown> {
  const control = objects.find((obj) => {
    if (obj.type !== "control_response") return false;
    const response = obj.response as { request_id?: unknown } | undefined;
    return response?.request_id === requestId;
  });
  expect(control).toBeDefined();

  const response = control?.response as
    | { subtype?: unknown; response?: unknown }
    | undefined;
  expect(response?.subtype).toBe("success");
  return response?.response as Record<string, unknown>;
}

function payloadMessages(payload: Record<string, unknown>) {
  expect(Array.isArray(payload.messages)).toBe(true);
  return payload.messages as Array<{ message_type?: string }>;
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

  test("creates a new headless agent through the dev backend without API credentials", async () => {
    const result = await runCli([
      "-p",
      "ping",
      "--new-agent",
      "--dev-backend",
      "fake-headless",
      "--permission-mode",
      "plan",
      "--no-skills",
      "--no-memfs",
      "--memfs-startup",
      "skip",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pong");
    expect(result.stderr).not.toContain("Missing LETTA_API_KEY");
    expect(result.stderr).not.toContain("Failed to connect to Letta server");
    expect(result.stderr).not.toContain("Memory flags failed");
  });

  test("rejects remote MemFS enable on dev backends without API credentials", async () => {
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
      "--memfs",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Error: --memfs is not supported by this backend yet",
    );
    expect(result.stderr).not.toContain("Missing LETTA_API_KEY");
  });

  test("runs stream-json controls and repeated user turns without API credentials", async () => {
    const result = await runStreamJsonCli();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Missing LETTA_API_KEY");
    expect(result.stderr).not.toContain("Failed to connect to Letta server");

    const controlResponses = result.objects.filter(
      (obj) => obj.type === "control_response",
    );
    expect(controlResponses).toHaveLength(4);
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

    const listAfterFirst = payloadMessages(
      findControlPayload(result.objects, "list-after-1"),
    );
    expect(listAfterFirst.map((message) => message.message_type)).toEqual([
      "assistant_message",
      "user_message",
    ]);
    expect(JSON.stringify(listAfterFirst)).toContain("ping one");

    const listAfterSecond = payloadMessages(
      findControlPayload(result.objects, "list-after-2"),
    );
    expect(listAfterSecond.map((message) => message.message_type)).toEqual([
      "assistant_message",
      "user_message",
      "assistant_message",
      "user_message",
    ]);
    expect(JSON.stringify(listAfterSecond)).toContain("ping one");
    expect(JSON.stringify(listAfterSecond)).toContain("ping two");

    const bootstrapAfterSecond = payloadMessages(
      findControlPayload(result.objects, "bootstrap-after-2"),
    );
    expect(bootstrapAfterSecond).toHaveLength(4);
  });

  test("runs a deterministic tool-call turn without API credentials", async () => {
    const result = await runStreamJsonToolCli();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Missing LETTA_API_KEY");
    expect(result.stderr).not.toContain("Failed to connect to Letta server");

    expect(
      result.objects.some(
        (obj) =>
          obj.type === "message" &&
          obj.message_type === "approval_request_message" &&
          JSON.stringify(obj).includes("ShellCommand"),
      ),
    ).toBe(true);
    expect(
      result.objects.some(
        (obj) =>
          obj.type === "auto_approval" &&
          JSON.stringify(obj).includes("ShellCommand"),
      ),
    ).toBe(true);
    expect(
      result.objects.some(
        (obj) =>
          obj.type === "result" &&
          JSON.stringify(obj).includes("tool result received (success)"),
      ),
    ).toBe(true);

    const messages = payloadMessages(
      findControlPayload(result.objects, "list-after-tool"),
    );
    expect(messages.map((message) => message.message_type)).toEqual([
      "assistant_message",
      "approval_response_message",
      "approval_request_message",
      "user_message",
    ]);
    expect(JSON.stringify(messages)).toContain("deterministic-tool-ok");
  });
});
