import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Mode = "all" | "channel" | "headless" | "listener-direct" | "tui";

type Args = {
  mode: Mode;
  model: string;
  timeoutMs: number;
};

type SmokeContext = {
  name: string;
  cwd: string;
  transcriptRoot: string;
  backgroundDir: string;
  token: string;
};

type ParentRun = {
  agentId: string;
  conversationId: string;
  resultText: string;
};

type ReflectionTaskReport = {
  logPath: string;
  status: string;
  agentId: string;
  conversationId: string;
  text: string;
};

type ReflectionState = {
  schema_version?: string;
  reflected_through_message_id?: string;
  total_completed_turns?: number;
  reflected_completed_turns?: number;
  turns_since_last_successful_reflection?: number;
  last_reflection_started_at?: string;
  last_reflection_succeeded_at?: string;
};

const PROJECT_ROOT = process.cwd();
const CLEAN_ENV_KEYS = [
  "LETTA_AGENT_ID",
  "AGENT_ID",
  "MEMORY_DIR",
  "LETTA_MEMORY_DIR",
  "LETTA_PARENT_AGENT_ID",
  "LETTA_CODE_AGENT_ROLE",
];

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: "all",
    model: "auto",
    timeoutMs: 240_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--mode") {
      const next = argv[++i] as Mode | undefined;
      if (
        next === "all" ||
        next === "channel" ||
        next === "headless" ||
        next === "listener-direct" ||
        next === "tui"
      ) {
        args.mode = next;
      } else {
        throw new Error(`Invalid --mode value: ${next}`);
      }
      continue;
    }
    if (value === "--model" || value === "-m") {
      const next = argv[++i];
      if (!next) {
        throw new Error("Missing --model value");
      }
      args.model = next;
      continue;
    }
    if (value === "--timeout-ms") {
      const next = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isFinite(next) || next <= 0) {
        throw new Error("Invalid --timeout-ms value");
      }
      args.timeoutMs = next;
      continue;
    }
    if (value === "--help" || value === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function printUsage(): void {
  console.log(
    `Usage: bun run src/test-utils/reflection-live-smoke.ts [options]

Runs live reflection smoke tests against the configured Letta backend.

Options:
  --mode <all|headless|tui|channel|listener-direct>
      all             Run the currently passing live smokes (headless, tui, channel)
      headless        Headless bidirectional auto reflection
      tui             Interactive TUI /reflect command, driven by a PTY
      channel         Local channel /reflection command through listener lifecycle
      listener-direct Direct websocket/listener step-count path (currently reproduces #2609)
  --model, -m <model> Model handle to use for parent smoke agents (default: auto)
  --timeout-ms <ms>   Per-test timeout (default: 240000)
`.trim(),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeContext(name: string): SmokeContext {
  return {
    name,
    cwd: PROJECT_ROOT,
    transcriptRoot: mkdtempSync(join(tmpdir(), `letta-reflection-${name}.`)),
    backgroundDir: mkdtempSync(join(tmpdir(), `letta-reflection-bg-${name}.`)),
    token: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

function subagentLauncherArgs(cwd: string): string[] {
  return [
    "--loader=.md:text",
    "--loader=.mdx:text",
    "--loader=.txt:text",
    "run",
    join(cwd, "src/index.ts"),
  ];
}

function cleanEnv(ctx: SmokeContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of CLEAN_ENV_KEYS) {
    delete env[key];
  }
  env.LETTA_DEBUG = "0";
  env.LETTA_TRANSCRIPT_ROOT = ctx.transcriptRoot;
  // Internal isolation for background task logs so this script can inspect the
  // reflection report deterministically without colliding with other Letta runs.
  env.LETTA_SCRATCHPAD = ctx.backgroundDir;
  env.LETTA_CODE_BIN = process.execPath;
  env.LETTA_CODE_BIN_ARGS_JSON = JSON.stringify(subagentLauncherArgs(ctx.cwd));
  return env;
}

function applyCleanEnvToCurrentProcess(ctx: SmokeContext): void {
  for (const key of CLEAN_ENV_KEYS) {
    delete process.env[key];
  }
  process.env.LETTA_DEBUG = "0";
  process.env.LETTA_TRANSCRIPT_ROOT = ctx.transcriptRoot;
  process.env.LETTA_SCRATCHPAD = ctx.backgroundDir;
  process.env.LETTA_CODE_BIN = process.execPath;
  process.env.LETTA_CODE_BIN_ARGS_JSON = JSON.stringify(
    subagentLauncherArgs(ctx.cwd),
  );
}

function statePath(ctx: SmokeContext, agentId: string, conversationId: string) {
  return join(ctx.transcriptRoot, agentId, conversationId, "state.json");
}

function readReflectionState(
  ctx: SmokeContext,
  agentId: string,
  conversationId: string,
): ReflectionState | null {
  const path = statePath(ctx, agentId, conversationId);
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf-8")) as ReflectionState;
}

async function waitForReflectionSuccess(
  ctx: SmokeContext,
  agentId: string,
  conversationId: string,
  timeoutMs: number,
): Promise<ReflectionState> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = readReflectionState(ctx, agentId, conversationId);
    if (state?.last_reflection_succeeded_at) {
      return state;
    }
    await sleep(1000);
  }
  throw new Error(
    `[${ctx.name}] Timed out waiting for reflection success; state=${JSON.stringify(
      readReflectionState(ctx, agentId, conversationId),
    )}`,
  );
}

function extractJsonLines(text: string): unknown[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          if (typeof record.text === "string") {
            return record.text;
          }
          if (typeof record.reasoning === "string") {
            return record.reasoning;
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return content === undefined || content === null ? "" : String(content);
}

async function runHeadlessOneShot(
  ctx: SmokeContext,
  args: Args,
  prompt: string,
  conversationId?: string,
): Promise<ParentRun> {
  const result = await runCommand(
    process.execPath,
    [
      "run",
      "dev",
      "--",
      "--new-agent",
      "--memfs",
      ...(conversationId ? ["--conversation", conversationId] : []),
      "--reflection-trigger",
      "off",
      "-m",
      args.model,
      "--output-format",
      "stream-json",
      "-p",
      prompt,
    ],
    {
      cwd: ctx.cwd,
      env: cleanEnv(ctx),
      timeoutMs: args.timeoutMs,
    },
  );
  const events = extractJsonLines(result.stdout);
  const init = events.find(
    (
      event,
    ): event is {
      type: string;
      subtype?: string;
      agent_id: string;
      conversation_id: string;
    } =>
      Boolean(
        event &&
          typeof event === "object" &&
          (event as { type?: unknown }).type === "system" &&
          (event as { subtype?: unknown }).subtype === "init",
      ),
  );
  const finalResult = events.findLast(
    (
      event,
    ): event is {
      type: string;
      subtype?: string;
      result?: string;
      is_error?: boolean;
    } =>
      Boolean(
        event &&
          typeof event === "object" &&
          (event as { type?: unknown }).type === "result",
      ),
  );
  if (!init || !finalResult) {
    throw new Error(
      `[${ctx.name}] Could not parse headless setup output\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  if (finalResult.subtype !== "success" || finalResult.is_error) {
    throw new Error(
      `[${ctx.name}] Headless setup failed: ${JSON.stringify(finalResult)}`,
    );
  }
  return {
    agentId: init.agent_id,
    conversationId: init.conversation_id,
    resultText: finalResult.result ?? "",
  };
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
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
      proc.kill("SIGKILL");
      reject(
        new Error(
          `Command timed out: ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, options.timeoutMs);

    proc.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (exitCode !== 0) {
        reject(
          new Error(
            `Command failed (${exitCode}): ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function latestTaskLogs(backgroundDir: string): string[] {
  if (!existsSync(backgroundDir)) {
    return [];
  }
  return readdirSync(backgroundDir)
    .filter((name) => name.startsWith("task_") && name.endsWith(".log"))
    .map((name) => join(backgroundDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function parseTaskReport(logPath: string): ReflectionTaskReport | null {
  const text = readFileSync(logPath, "utf-8");
  const match = text.match(
    /subagent_type=reflection\s+subagent_id=\S+\s+subagent_status=(\w+)\s+agent_id=(agent-[a-f0-9-]+)\s+conversation_id=([^\s]+)/,
  );
  if (!match) {
    return null;
  }
  return {
    logPath,
    status: match[1] ?? "unknown",
    agentId: match[2] ?? "",
    conversationId: match[3] ?? "default",
    text,
  };
}

async function waitForReflectionTaskReport(
  ctx: SmokeContext,
  timeoutMs: number,
): Promise<ReflectionTaskReport> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const logPath of latestTaskLogs(ctx.backgroundDir)) {
      const parsed = parseTaskReport(logPath);
      if (parsed) {
        return parsed;
      }
    }
    await sleep(500);
  }
  throw new Error(
    `[${ctx.name}] Timed out waiting for reflection task report in ${ctx.backgroundDir}`,
  );
}

async function exportAgentReport(
  agentId: string,
  conversationId: string,
): Promise<string> {
  const { settingsManager } = await import("@/settings-manager");
  const { getClient } = await import("@/backend/api/client");
  await settingsManager.initialize();
  const client = await getClient();
  const exported = await client.agents.exportFile(agentId, {
    conversation_id: conversationId,
  });
  const agentFile =
    typeof exported === "string"
      ? (JSON.parse(exported) as Record<string, unknown>)
      : (exported as Record<string, unknown>);
  const agents = Array.isArray(agentFile.agents) ? agentFile.agents : [];
  const [agent] = agents as Array<Record<string, unknown>>;
  const messages = Array.isArray(agent?.messages) ? agent.messages : [];
  const assistant = [...messages]
    .reverse()
    .find((message): message is Record<string, unknown> =>
      Boolean(
        message &&
          typeof message === "object" &&
          (message as { role?: unknown }).role === "assistant",
      ),
    );
  return contentToText(assistant?.content);
}

async function verifyReflectionReport(
  ctx: SmokeContext,
  report: ReflectionTaskReport,
): Promise<string> {
  if (report.status !== "success") {
    throw new Error(
      `[${ctx.name}] Reflection task failed; see ${report.logPath}\n${report.text}`,
    );
  }
  const exportedReport = await exportAgentReport(
    report.agentId,
    report.conversationId,
  );
  const combinedReport = `${report.text}\n${exportedReport}`;
  if (
    /cross-agent memory guard|Permission denied by cross-agent memory guard|blocked by a cross-agent memory guard|preventing any filesystem access|push failed|failed to push/i.test(
      combinedReport,
    )
  ) {
    throw new Error(
      `[${ctx.name}] Reflection agent hit the cross-agent guard; see ${report.logPath}\n${exportedReport}`,
    );
  }
  return exportedReport;
}

async function runHeadlessBidirectionalSmoke(args: Args): Promise<void> {
  const ctx = makeContext("headless");
  const env = cleanEnv(ctx);
  const child = spawn(
    process.execPath,
    [
      "run",
      "dev",
      "--",
      "--new-agent",
      "--memfs",
      "--reflection-trigger",
      "step-count",
      "--reflection-step-count",
      "1",
      "-m",
      args.model,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
    ],
    { cwd: ctx.cwd, env, stdio: ["pipe", "pipe", "pipe"] },
  );

  let stdoutBuffer = "";
  let stderr = "";
  let agentId = "";
  let conversationId = "";
  let resultCount = 0;
  let doneResolve!: () => void;
  let doneReject!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    doneResolve = resolve;
    doneReject = reject;
  });

  function sendUser(text: string): void {
    child.stdin.write(
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: text },
      })}\n`,
    );
  }

  async function handleEvent(event: Record<string, unknown>): Promise<void> {
    if (event.type === "system" && event.subtype === "init") {
      agentId = String(event.agent_id ?? "");
      conversationId = String(event.conversation_id ?? "");
      console.log(
        `[headless] parent=${agentId} conversation=${conversationId} token=${ctx.token}`,
      );
      sendUser(
        `This is a disposable reflection smoke test with marker ${ctx.token}; do not store the marker as durable memory. Reply exactly: headless one ok.`,
      );
      return;
    }
    if (event.type === "result") {
      resultCount += 1;
      if (event.subtype !== "success") {
        throw new Error(`[headless] Turn failed: ${JSON.stringify(event)}`);
      }
      if (resultCount === 1) {
        sendUser(
          "Second headless bidirectional turn to trigger step-count reflection. Reply exactly: headless two ok.",
        );
        return;
      }
      if (resultCount === 2) {
        const state = await waitForReflectionSuccess(
          ctx,
          agentId,
          conversationId,
          args.timeoutMs,
        );
        const taskReport = await waitForReflectionTaskReport(
          ctx,
          args.timeoutMs,
        );
        const exportedReport = await verifyReflectionReport(ctx, taskReport);
        console.log(
          `[headless] reflection=${taskReport.agentId}/${taskReport.conversationId} state=${JSON.stringify(
            state,
          )}`,
        );
        console.log(`[headless] report=${exportedReport.slice(0, 240)}`);
        child.stdin.end();
        doneResolve();
      }
    }
  }

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    let lineBreak = stdoutBuffer.indexOf("\n");
    while (lineBreak >= 0) {
      const line = stdoutBuffer.slice(0, lineBreak).trim();
      stdoutBuffer = stdoutBuffer.slice(lineBreak + 1);
      if (!line.startsWith("{")) {
        lineBreak = stdoutBuffer.indexOf("\n");
        continue;
      }
      try {
        void handleEvent(JSON.parse(line) as Record<string, unknown>).catch(
          doneReject,
        );
      } catch {
        // Ignore non-protocol JSON-looking logs.
      }
      lineBreak = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.on("error", doneReject);
  child.on("exit", (code, signal) => {
    if (resultCount < 2) {
      doneReject(
        new Error(
          `[headless] exited early code=${code} signal=${signal}\n${stderr}`,
        ),
      );
    }
  });

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    doneReject(new Error(`[headless] timed out\n${stderr}`));
  }, args.timeoutMs);
  try {
    await done;
  } finally {
    clearTimeout(timeout);
    child.kill("SIGTERM");
  }
}

async function runTuiReflectionSmoke(args: Args): Promise<void> {
  const ctx = makeContext("tui");
  applyCleanEnvToCurrentProcess(ctx);
  const parent = await runHeadlessOneShot(
    ctx,
    args,
    `This is a disposable TUI reflection smoke test with marker ${ctx.token}; do not store the marker as durable memory. Reply exactly: tui setup ok.`,
    "default",
  );
  console.log(
    `[tui] parent=${parent.agentId} conversation=${parent.conversationId} token=${ctx.token}`,
  );
  const { appendTranscriptDeltaJsonl } = await import(
    "@/cli/helpers/reflection-transcript"
  );
  await appendTranscriptDeltaJsonl(parent.agentId, parent.conversationId, [
    {
      kind: "user",
      id: `user-${ctx.token}`,
      text: `Synthetic TUI smoke transcript marker ${ctx.token}. This marker is ephemeral and should not be stored as durable memory.`,
    },
    {
      kind: "assistant",
      id: `assistant-${ctx.token}`,
      text: parent.resultText,
      phase: "finished",
    },
  ]);
  const driverDir = mkdtempSync(join(tmpdir(), "letta-tui-driver."));
  const driverPath = join(driverDir, "driver.cjs");
  const optionsPath = join(driverDir, "options.json");
  writeFileSync(
    driverPath,
    `const fs = require("node:fs");
const pty = require("node-pty");
const opts = JSON.parse(fs.readFileSync(process.env.REFLECTION_TUI_DRIVER_OPTIONS, "utf8"));
const child = pty.spawn(opts.command, opts.args, {
  cwd: opts.cwd,
  env: opts.env,
  cols: 120,
  rows: 40,
});
let output = "";
let sent = false;
const timeout = setTimeout(() => {
  console.error("TUI_DRIVER_TIMEOUT\\n" + output.slice(-4000));
  child.kill();
  process.exit(2);
}, opts.timeoutMs);
function maybeSendReflect() {
  if (sent || !/Try |›|Letta Code ·/.test(output)) return;
  sent = true;
  setTimeout(() => {
    child.write("/reflect\\r");
    setTimeout(() => {
      child.write("\\r");
      console.log("\\nTUI_REFLECT_SENT");
    }, 1000);
  }, 1500);
}
child.onData((data) => {
  output += data;
  process.stdout.write(data);
  maybeSendReflect();
});
child.onExit((event) => {
  clearTimeout(timeout);
  if (!sent) {
    console.error("TUI exited before ready: " + JSON.stringify(event) + "\\n" + output.slice(-4000));
    process.exit(1);
  }
  process.exit(0);
});
`,
  );
  writeFileSync(
    optionsPath,
    JSON.stringify({
      command: process.execPath,
      args: [
        "run",
        "dev",
        "--",
        "--agent",
        parent.agentId,
        "--reflection-trigger",
        "off",
        "-m",
        args.model,
      ],
      cwd: ctx.cwd,
      env: cleanEnv(ctx),
      timeoutMs: args.timeoutMs,
    }),
  );
  const proc = spawn("node", [driverPath], {
    cwd: ctx.cwd,
    env: {
      ...process.env,
      REFLECTION_TUI_DRIVER_OPTIONS: optionsPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let sentResolve!: () => void;
  let sentReject!: (error: Error) => void;
  const reflectSent = new Promise<void>((resolve, reject) => {
    sentResolve = resolve;
    sentReject = reject;
  });
  const onDriverOutput = (data: Buffer | string) => {
    output += data.toString();
    if (output.includes("TUI_REFLECT_SENT")) {
      sentResolve();
    }
  };
  proc.stdout?.on("data", onDriverOutput);
  proc.stderr?.on("data", onDriverOutput);
  proc.on("error", sentReject);
  proc.on("exit", (code, signal) => {
    if (!output.includes("TUI_REFLECT_SENT")) {
      sentReject(
        new Error(
          `[tui] driver exited before sending /reflect code=${code} signal=${signal}\n${output.slice(
            -4000,
          )}`,
        ),
      );
    }
  });
  try {
    await reflectSent;

    const state = await waitForReflectionSuccess(
      ctx,
      parent.agentId,
      parent.conversationId,
      args.timeoutMs,
    );
    const taskReport = await waitForReflectionTaskReport(ctx, args.timeoutMs);
    const exportedReport = await verifyReflectionReport(ctx, taskReport);
    console.log(
      `[tui] reflection=${taskReport.agentId}/${taskReport.conversationId} state=${JSON.stringify(
        state,
      )}`,
    );
    console.log(`[tui] report=${exportedReport.slice(0, 240)}`);
  } finally {
    proc.kill("SIGTERM");
    rmSync(driverDir, { recursive: true, force: true });
  }
}

async function runChannelReflectionSmoke(args: Args): Promise<void> {
  const ctx = makeContext("channel");
  applyCleanEnvToCurrentProcess(ctx);
  const parent = await runHeadlessOneShot(
    ctx,
    args,
    `This is a disposable channel reflection smoke test with marker ${ctx.token}; do not store the marker as durable memory. Reply exactly: channel setup ok.`,
  );
  console.log(
    `[channel] parent=${parent.agentId} conversation=${parent.conversationId} token=${ctx.token}`,
  );

  const [
    { settingsManager },
    { __testOverrideChannelsRoot },
    channels,
    listen,
  ] = await Promise.all([
    import("@/settings-manager"),
    import("@/channels/config"),
    import("@/channels/registry"),
    import("@/websocket/listen-client"),
  ]);
  const { addRoute } = await import("@/channels/routing");
  await settingsManager.initialize();
  settingsManager.setMemfsEnabled(parent.agentId, true);
  __testOverrideChannelsRoot(
    mkdtempSync(join(tmpdir(), "letta-channels-smoke.")),
  );

  // Seed the reflection transcript through the actual listener turn path. The
  // channel slash command only launches reflection; it does not itself create
  // transcript content.
  const seedListener = listen.__listenClientTestUtils.createListenerRuntime();
  const seedRuntime =
    listen.__listenClientTestUtils.getOrCreateConversationRuntime(
      seedListener,
      parent.agentId,
      parent.conversationId,
    );
  await listen.__listenClientTestUtils.handleIncomingMessage(
    {
      type: "message",
      agentId: parent.agentId,
      conversationId: parent.conversationId,
      messages: [
        {
          role: "user",
          content:
            "Channel reflection smoke preflight turn. Reply exactly: channel preflight ok.",
        },
      ],
    },
    { readyState: 1, send: () => {} } as never,
    seedRuntime,
  );

  const registry = channels.ensureChannelRegistry();
  const replies: string[] = [];
  registry.registerAdapter({
    id: "slack:reflection-smoke",
    channelId: "slack",
    accountId: "reflection-smoke",
    name: "Slack Reflection Smoke",
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    sendMessage: async () => ({ messageId: "reflection-smoke-message" }),
    sendDirectReply: async (_chatId: string, text: string) => {
      replies.push(text);
    },
    onMessage: undefined,
  });
  await listen.startLocalChannelListener({
    connectionId: "reflection-smoke",
    deviceId: "reflection-smoke-device",
    connectionName: "Reflection Smoke",
    onConnected: () => {},
    onError: (error) => {
      throw error;
    },
  });
  addRoute("slack", {
    accountId: "reflection-smoke",
    chatId: "C-reflection-smoke",
    chatType: "channel",
    threadId: "reflection-smoke-thread",
    agentId: parent.agentId,
    conversationId: parent.conversationId,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const adapter = registry.getAdapter("slack", "reflection-smoke");
  await adapter?.onMessage?.({
    channel: "slack",
    accountId: "reflection-smoke",
    chatId: "C-reflection-smoke",
    senderId: "U-reflection-smoke",
    senderName: "Reflection Smoke",
    text: "/reflection",
    timestamp: Date.now(),
    messageId: "reflection-smoke-command",
    threadId: "reflection-smoke-thread",
    chatType: "channel",
  });
  if (!replies.some((reply) => reply.includes("Started a reflection pass"))) {
    throw new Error(
      `[channel] Expected reflection start reply; got ${JSON.stringify(replies)}`,
    );
  }
  const state = await waitForReflectionSuccess(
    ctx,
    parent.agentId,
    parent.conversationId,
    args.timeoutMs,
  );
  const taskReport = await waitForReflectionTaskReport(ctx, args.timeoutMs);
  const exportedReport = await verifyReflectionReport(ctx, taskReport);
  listen.stopListenerClient();
  console.log(
    `[channel] reflection=${taskReport.agentId}/${taskReport.conversationId} state=${JSON.stringify(
      state,
    )}`,
  );
  console.log(`[channel] report=${exportedReport.slice(0, 240)}`);
}

async function runListenerDirectSmoke(args: Args): Promise<void> {
  const ctx = makeContext("listener-direct");
  applyCleanEnvToCurrentProcess(ctx);
  const [{ settingsManager }, listen] = await Promise.all([
    import("@/settings-manager"),
    import("@/websocket/listen-client"),
  ]);
  const parent = await runHeadlessOneShot(
    ctx,
    args,
    `This is a disposable direct-listener reflection smoke test with marker ${ctx.token}; do not store the marker as durable memory. Reply exactly: listener setup ok.`,
  );
  await settingsManager.initialize();
  settingsManager.setMemfsEnabled(parent.agentId, true);
  const listener = listen.__listenClientTestUtils.createListenerRuntime();
  const runtime = listen.__listenClientTestUtils.getOrCreateConversationRuntime(
    listener,
    parent.agentId,
    parent.conversationId,
  );
  const socket = {
    readyState: 1,
    send: () => {},
  };
  await listen.__listenClientTestUtils.handleIncomingMessage(
    {
      type: "message",
      agentId: parent.agentId,
      conversationId: parent.conversationId,
      messages: [
        {
          role: "user",
          content:
            "Direct listener turn to trigger step-count reflection. Reply exactly: listener direct ok.",
        },
      ],
    },
    socket as never,
    runtime,
  );
  const state = await waitForReflectionSuccess(
    ctx,
    parent.agentId,
    parent.conversationId,
    args.timeoutMs,
  );
  const taskReport = await waitForReflectionTaskReport(ctx, args.timeoutMs);
  const exportedReport = await verifyReflectionReport(ctx, taskReport);
  console.log(
    `[listener-direct] reflection=${taskReport.agentId}/${taskReport.conversationId} state=${JSON.stringify(
      state,
    )}`,
  );
  console.log(`[listener-direct] report=${exportedReport.slice(0, 240)}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const modes =
    args.mode === "all"
      ? (["headless", "tui", "channel"] as const)
      : ([args.mode] as const);
  for (const mode of modes) {
    if (mode === "headless") {
      await runHeadlessBidirectionalSmoke(args);
    } else if (mode === "tui") {
      await runTuiReflectionSmoke(args);
    } else if (mode === "channel") {
      await runChannelReflectionSmoke(args);
    } else if (mode === "listener-direct") {
      await runListenerDirectSmoke(args);
    }
  }
  console.log(`[reflection-smoke] PASS (${modes.join(", ")})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
