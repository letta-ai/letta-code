import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import {
  ANTHROPIC_DEFAULT_TOOLS,
  GEMINI_DEFAULT_TOOLS,
  OPENAI_DEFAULT_TOOLS,
  OPENAI_PASCAL_TOOLS,
} from "@/tools/manager";
import MonitorSchema from "@/tools/schemas/Monitor.json";
import {
  clearPendingMessages,
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import {
  MONITOR_OUTPUT_FILE_BYTES,
  monitor,
  stopMonitorsForProcessExit,
} from "./monitor";
import { MONITOR_EVENT_BUFFER_CHARS } from "./monitor-event-stream";
import { backgroundProcesses } from "./process_manager";
import { task_output } from "./task-output";
import { task_stop } from "./task-stop";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for monitor state");
    }
    await Bun.sleep(10);
  }
}

describe("Monitor", () => {
  let scratchpad: string;
  let previousScratchpad: string | undefined;
  let queuedMessages: QueuedMessage[];
  let childScriptIndex: number;

  function quoteCommandArgument(value: string): string {
    return process.platform === "win32"
      ? `"${value.replaceAll('"', '""')}"`
      : JSON.stringify(value);
  }

  function nodeCommand(script: string): string {
    const scriptPath = join(scratchpad, `monitor-child-${childScriptIndex}.js`);
    childScriptIndex += 1;
    writeFileSync(scriptPath, script);
    return `${quoteCommandArgument(process.execPath)} ${quoteCommandArgument(scriptPath)}`;
  }

  beforeEach(() => {
    previousScratchpad = process.env.LETTA_SCRATCHPAD;
    scratchpad = mkdtempSync(join(tmpdir(), "monitor-test-"));
    process.env.LETTA_SCRATCHPAD = scratchpad;
    queuedMessages = [];
    childScriptIndex = 0;
    clearPendingMessages();
    setMessageQueueAdder((message) => queuedMessages.push(message));
  });

  afterEach(() => {
    for (const processState of backgroundProcesses.values()) {
      processState.completionNotificationSuppressed = true;
      try {
        processState.process.kill("SIGKILL");
      } catch {
        // The source already ended.
      }
    }
    backgroundProcesses.clear();
    setMessageQueueAdder(null);
    clearPendingMessages();
    if (previousScratchpad === undefined) {
      delete process.env.LETTA_SCRATCHPAD;
    } else {
      process.env.LETTA_SCRATCHPAD = previousScratchpad;
    }
    rmSync(scratchpad, { recursive: true, force: true });
  });

  test("is exposed in the Anthropic and Codex toolsets", () => {
    expect(ANTHROPIC_DEFAULT_TOOLS).toContain("Monitor");
    expect(OPENAI_PASCAL_TOOLS).toContain("Monitor");
    expect(OPENAI_DEFAULT_TOOLS).not.toContain("Monitor");
    expect(GEMINI_DEFAULT_TOOLS).not.toContain("Monitor");
  });

  test("matches the reference schema defaults and descriptions", () => {
    expect(MonitorSchema.required).toEqual(["description"]);
    expect(MonitorSchema).not.toHaveProperty("oneOf");
    expect(MonitorSchema.properties.description.description).toBe(
      "Short human-readable description of what you are monitoring (shown in notifications).",
    );
    expect(MonitorSchema.properties.timeout_ms).toMatchObject({
      minimum: 1000,
      default: 300000,
      description:
        "Kill the monitor after this deadline. Default 300000ms, max 3600000ms. Ignored when persistent is true.",
    });
    expect(MonitorSchema.properties.persistent).toMatchObject({
      default: false,
      description:
        "Run for the lifetime of the session (no timeout). Use for session-length watches like PR monitoring or log tails. Stop with TaskStop.",
    });
    expect(MonitorSchema.properties.ws.properties.protocols).not.toHaveProperty(
      "uniqueItems",
    );
  });

  test("validates source, timeout, and WebSocket inputs", async () => {
    await expect(
      monitor({
        description: "invalid",
        timeout_ms: 999,
        persistent: false,
        command: "echo hi",
      }),
    ).rejects.toThrow("timeout_ms");
    await expect(
      monitor({
        description: "invalid",
        timeout_ms: 1000,
        persistent: false,
        command: "echo hi",
        ws: { url: "wss://example.com" },
      }),
    ).rejects.toThrow("exactly one");
    await expect(
      monitor({
        description: "invalid",
        timeout_ms: 1000,
        persistent: false,
        ws: { url: "https://example.com" },
      }),
    ).rejects.toThrow("ASCII ws:// or wss://");
    await expect(
      monitor({
        description: "invalid",
        timeout_ms: 1000,
        persistent: false,
        ws: { url: "wss://example.com/a b" },
      }),
    ).rejects.toThrow("ASCII ws:// or wss://");
    await expect(
      monitor({
        description: "invalid",
        timeout_ms: 1000,
        persistent: false,
        ws: {
          url: "wss://example.com",
          protocols: ["events", "events"],
        },
      }),
    ).rejects.toThrow("unique");
    await expect(
      monitor({
        description: "invalid",
        command: "printf 'ok'\rprintf 'hidden'",
      }),
    ).rejects.toThrow("control characters");
  });

  test("accepts an empty ws placeholder and uses the reference defaults", async () => {
    const result = await monitor({
      description: "defaults",
      command: nodeCommand('process.stdout.write("done\\n")'),
      ws: { url: "", protocols: [] },
    });

    expect(result).toMatchObject({ timeoutMs: 300000, persistent: false });
    await waitFor(
      () => backgroundProcesses.get(result.taskId)?.status === "completed",
    );
  });

  test("streams command stdout as scoped notifications and records stderr", async () => {
    const result = await monitor({
      description: "build output",
      timeout_ms: 5000,
      persistent: false,
      command: nodeCommand(
        'process.stdout.write("first\\nsecond\\n"); process.stderr.write("warning\\n")',
      ),
      parentScope: { agentId: "agent-monitor", conversationId: "conv-monitor" },
    });

    expect(result.timeoutMs).toBe(5000);
    expect(result.persistent).toBe(false);
    expect(result.content[0]?.text).toContain(
      `Monitor started (task ${result.taskId}, timeout 5000ms)`,
    );
    await waitFor(
      () => backgroundProcesses.get(result.taskId)?.status === "completed",
    );

    const event = queuedMessages.find((message) =>
      message.text.includes("Monitor event"),
    );
    expect(event).toMatchObject({
      kind: "task_notification",
      agentId: "agent-monitor",
      conversationId: "conv-monitor",
    });
    expect(event?.text).toContain("first\nsecond");
    expect(event?.text).not.toContain("warning");

    const output = await task_output({
      task_id: result.taskId,
      block: false,
      timeout: 1000,
    });
    expect(output.status).toBe("completed");
    expect(output.message).toContain("first");
    expect(output.message).toContain("warning");
  });

  test("redacts split invocation secrets from notifications and stored output", async () => {
    const secret = "he$$o";
    const result = await monitor({
      description: "secret output",
      timeout_ms: 5000,
      persistent: false,
      command: nodeCommand(
        "const value = process.env.PASSWORD ?? ''; process.stdout.write(value.slice(0, 2)); setTimeout(() => process.stdout.write(value.slice(2) + '\\n'), 25)",
      ),
      secretEnv: { PASSWORD: secret },
    });

    await waitFor(
      () => backgroundProcesses.get(result.taskId)?.status === "completed",
    );
    const eventText = queuedMessages.map((message) => message.text).join("\n");
    expect(eventText).toContain("PASSWORD=&lt;REDACTED&gt;");
    expect(eventText).not.toContain(secret);

    const output = await task_output({
      task_id: result.taskId,
      block: false,
      timeout: 1000,
    });
    expect(output.message).toContain("PASSWORD=<REDACTED>");
    expect(output.message).not.toContain(secret);

    const outputFile = backgroundProcesses.get(result.taskId)?.outputFile;
    expect(readFileSync(outputFile as string, "utf8")).not.toContain(secret);
  });

  test("persistent command monitors can be stopped with TaskStop", async () => {
    const result = await monitor({
      description: "long process",
      timeout_ms: 1000,
      persistent: true,
      command: nodeCommand(
        'process.stdout.write("pending\\n"); setInterval(() => {}, 1000)',
      ),
    });

    expect(result).toMatchObject({
      timeoutMs: 0,
      persistent: true,
    });
    await waitFor(
      () => (backgroundProcesses.get(result.taskId)?.totalStdoutLines ?? 0) > 0,
    );
    expect(await task_stop({ task_id: result.taskId })).toEqual({
      killed: true,
    });
    expect(backgroundProcesses.get(result.taskId)?.status).toBe("failed");
    expect(
      (
        await task_output({
          task_id: result.taskId,
          block: false,
          timeout: 1000,
        })
      ).message,
    ).toContain("pending");
    await Bun.sleep(250);
    expect(
      queuedMessages.some((message) => message.text.includes("Monitor event")),
    ).toBe(false);
  });

  test("fails a command monitor when its output file cannot be written", async () => {
    const result = await monitor({
      description: "output write failure",
      timeout_ms: 5_000,
      persistent: false,
      command: nodeCommand(
        'process.stdout.write("start\\n"); setTimeout(() => process.stdout.write("after\\n"), 1000); setTimeout(() => {}, 30000)',
      ),
    });
    const processState = backgroundProcesses.get(result.taskId);
    expect(processState?.outputFile).toBeDefined();
    rmSync(processState?.outputFile ?? "", { force: true });
    mkdirSync(processState?.outputFile ?? "");

    await waitFor(
      () => backgroundProcesses.get(result.taskId)?.status === "failed",
    );
  });

  test("caps captured output files", async () => {
    const result = await monitor({
      description: "large output",
      timeout_ms: 5000,
      persistent: false,
      command: nodeCommand(
        `process.stdout.write("x".repeat(${MONITOR_OUTPUT_FILE_BYTES}), () => setTimeout(() => process.stdout.write("y"), 250))`,
      ),
    });

    await waitFor(
      () => backgroundProcesses.get(result.taskId)?.status === "completed",
    );
    const outputFile = backgroundProcesses.get(result.taskId)?.outputFile;
    expect(outputFile).toBeString();
    expect(statSync(outputFile as string).size).toBe(MONITOR_OUTPUT_FILE_BYTES);
    expect(readFileSync(outputFile as string, "utf8")).toContain(
      `[output truncated at ${MONITOR_OUTPUT_FILE_BYTES} bytes]`,
    );
  });

  test("reports command monitor timeouts", async () => {
    const result = await monitor({
      description: "slow process",
      timeout_ms: 1000,
      persistent: false,
      command: nodeCommand("setInterval(() => {}, 1000)"),
    });

    await waitFor(
      () => backgroundProcesses.get(result.taskId)?.status === "failed",
      4000,
    );
    expect(
      queuedMessages.some((message) =>
        message.text.includes("Monitor timed out — re-arm if needed."),
      ),
    ).toBe(true);
  });

  test("accepts an empty command placeholder and streams WebSocket frames", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("WebSocket test server did not expose a TCP port");
    }
    server.on("connection", (socket) => {
      socket.send("first\nsecond");
      socket.send(Buffer.from([1, 2, 3]), { binary: true });
      socket.close(1000, "\u001b[31mdone\u001b[0m");
    });

    try {
      const result = await monitor({
        description: "socket events",
        timeout_ms: 5000,
        persistent: false,
        command: "",
        ws: {
          url: `ws://127.0.0.1:${address.port}/events?token=secret`,
        },
      });
      await waitFor(
        () => backgroundProcesses.get(result.taskId)?.status === "completed",
      );

      const eventText = queuedMessages
        .map((message) => message.text)
        .join("\n");
      expect(eventText).toContain("first\nsecond");
      expect(eventText).toContain("[binary frame, 3 bytes]");
      expect(eventText).toContain("[WebSocket closed: 1000 done]");
      expect(backgroundProcesses.get(result.taskId)?.command).toBe(
        `ws://127.0.0.1:${address.port}/events`,
      );

      const output = await task_output({
        task_id: result.taskId,
        block: false,
        timeout: 1000,
      });
      expect(output.message).toContain("first");
      expect(output.message).toContain("binary frame, 3 bytes");
      expect(output.message).toContain("[WebSocket closed: 1000 done]");
      expect(output.message).not.toContain("\u001b[31m");
    } finally {
      for (const client of server.clients) {
        client.terminate();
      }
      server.close();
    }
  });

  test("fails a WebSocket monitor when its output file cannot be written", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("WebSocket test server did not expose a TCP port");
    }
    let sendFrame = (): void => {};
    const connected = new Promise<void>((resolve) => {
      server.once("connection", (socket) => {
        sendFrame = () => socket.send("frame");
        resolve();
      });
    });

    try {
      const result = await monitor({
        description: "socket output write failure",
        ws: { url: `ws://127.0.0.1:${address.port}` },
      });
      await connected;
      const processState = backgroundProcesses.get(result.taskId);
      expect(processState?.outputFile).toBeDefined();
      rmSync(processState?.outputFile ?? "", { force: true });
      mkdirSync(processState?.outputFile ?? "");

      sendFrame();

      await waitFor(
        () => backgroundProcesses.get(result.taskId)?.status === "failed",
      );
      expect(
        backgroundProcesses
          .get(result.taskId)
          ?.stderr.join("")
          .includes("output file write failed"),
      ).toBe(true);
    } finally {
      for (const client of server.clients) {
        client.terminate();
      }
      server.close();
    }
  });

  test("drops oversized WebSocket frames before closing", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("WebSocket test server did not expose a TCP port");
    }
    server.on("connection", (socket) => {
      socket.send(Buffer.alloc(MONITOR_EVENT_BUFFER_CHARS + 1));
    });

    try {
      const result = await monitor({
        description: "large socket frame",
        ws: { url: `ws://127.0.0.1:${address.port}` },
      });
      await waitFor(
        () => backgroundProcesses.get(result.taskId)?.status === "failed",
      );

      const eventText = queuedMessages
        .map((message) => message.text)
        .join("\n");
      expect(eventText).toContain(
        `[Dropped ${MONITOR_EVENT_BUFFER_CHARS + 1}-byte frame (exceeds ${MONITOR_EVENT_BUFFER_CHARS}); closing]`,
      );
    } finally {
      for (const client of server.clients) {
        client.terminate();
      }
      server.close();
    }
  });

  test("persistent WebSocket monitors can be stopped with TaskStop", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("WebSocket test server did not expose a TCP port");
    }
    server.on("connection", (socket) => socket.send("pending"));

    try {
      const result = await monitor({
        description: "persistent socket",
        timeout_ms: 1000,
        persistent: true,
        ws: { url: `ws://127.0.0.1:${address.port}` },
      });
      await waitFor(
        () =>
          (backgroundProcesses.get(result.taskId)?.totalStdoutLines ?? 0) > 0,
      );
      expect(await task_stop({ task_id: result.taskId })).toEqual({
        killed: true,
      });
      await Bun.sleep(250);
      expect(backgroundProcesses.get(result.taskId)?.status).toBe("failed");
      expect(
        queuedMessages.some((message) =>
          message.text.includes("Monitor event"),
        ),
      ).toBe(false);
    } finally {
      for (const client of server.clients) {
        client.terminate();
      }
      server.close();
    }
  });

  test("force-stops running monitors when the process exits", () => {
    const signals: Array<string | number | undefined> = [];
    backgroundProcesses.set("monitor_exit", {
      process: {
        kill(signal) {
          signals.push(signal);
        },
      },
      command: "watch",
      stdout: [],
      stderr: [],
      status: "running",
      exitCode: null,
      lastReadIndex: { stdout: 0, stderr: 0 },
      kind: "monitor",
    });

    stopMonitorsForProcessExit();

    expect(signals).toEqual(["SIGKILL"]);
    expect(backgroundProcesses.get("monitor_exit")).toMatchObject({
      status: "failed",
      completionNotificationSuppressed: true,
    });
  });
});
