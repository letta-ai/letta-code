import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import {
  AppServerClient,
  type AppServerSocketConstructor,
} from "@/app-server-client";
import { __testSetBackend } from "@/backend";
import { LocalBackend } from "@/backend/local";
import { addTask, getTask } from "@/cron/cron-file";
import { getCronRunLogPath, readCronRunLogEntries } from "@/cron/run-log";
import { settingsManager } from "@/settings-manager";
import { startAppServer } from "@/websocket/app-server";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { getActiveRuntime } from "@/websocket/listener/runtime";

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for cron turn");
}

test("a server fires its own reminder when another process holds the shared cron lease", async () => {
  const home = await mkdtemp(join(tmpdir(), "app-server-cron-"));
  const keys = [
    "LETTA_HOME",
    "LETTA_DISABLE_MODS",
    "LETTA_DISABLE_CRON_SCHEDULER",
    "LETTA_MANAGED_CLOUD_RUNTIME",
  ] as const;
  const saved = keys.map((key) => process.env[key]);
  process.env.LETTA_HOME = home;
  process.env.LETTA_DISABLE_MODS = "1";
  delete process.env.LETTA_DISABLE_CRON_SCHEDULER;
  delete process.env.LETTA_MANAGED_CLOUD_RUNTIME;
  await settingsManager.initialize();
  const deviceId = settingsManager.getOrCreateDeviceId();
  // A second listener process claims the shared lease first. It has no
  // transport serving the SDK conversation hosted by the App Server below.
  const primary = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { startScheduler, stopScheduler } from "@/cron/scheduler";
    import { createRuntime } from "@/websocket/listener/lifecycle";
    import { getActiveRuntime, setActiveRuntime } from "@/websocket/listener/runtime";
    const ticks = [];
    const original = globalThis.setInterval;
    globalThis.setInterval = (fn, ms, ...args) => {
      if (ms === 60000) ticks.push(fn);
      return original(fn, ms, ...args);
    };
    setActiveRuntime(createRuntime());
    startScheduler({ readyState: 3 }, {
      connectionId: "primary", wsUrl: "ws://example.test", deviceId: ${JSON.stringify(deviceId)},
      connectionName: "primary", onConnected() {}, onDisconnected() {}, onError() {}
    }, async () => { throw new Error("Primary consumed another listener's reminder"); }, 0, true);
    writeFileSync(join(process.env.LETTA_HOME, "primary-ready"), "ready");
    await new Response(Bun.stdin.stream()).text();
    for (const tick of ticks) tick();
    await new Promise((resolve) => setImmediate(resolve));
    for (const runtime of getActiveRuntime().conversationRuntimes.values()) await runtime.messageQueue;
    stopScheduler();
  `,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const primaryOutput = Promise.all([
    new Response(primary.stdout).text(),
    new Response(primary.stderr).text(),
  ]);
  await waitFor(() => existsSync(join(home, "primary-ready")));
  const ticks: Array<() => void> = [];
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((
    fn: () => void,
    ms: number,
    ...args: unknown[]
  ) => {
    if (ms === 60_000) ticks.push(fn);
    return originalSetInterval(fn, ms, ...args);
  }) as typeof setInterval;
  const backend = new LocalBackend({
    storageDir: join(home, "backend"),
    executionMode: "deterministic",
    memfsEnabled: false,
  });
  __testSetBackend(backend);
  const request = spyOn(backend, "createConversationMessageStream");
  const server = await startAppServer({
    listen: "ws://127.0.0.1:0",
    connectionName: "secondary",
  });
  const client = await new AppServerClient({
    url: server.controlUrl,
    WebSocket: WebSocket as unknown as AppServerSocketConstructor,
  }).connect();
  try {
    const agent = await backend.createAgent({
      name: "Scheduled test",
      model: "anthropic/claude-sonnet-4-6",
    });
    settingsManager.setMemfsEnabled(agent.id, false);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    });
    const started = await client.runtimeStart({
      agent_id: agent.id,
      conversation_id: conversation.id,
      recover_approvals: false,
    });
    expect(started.success).toBe(true);
    const runtime = { agent_id: agent.id, conversation_id: conversation.id };
    let finished = false;
    client.onMessage((message) => {
      if (message.type === "turn_finished") finished = true;
    });
    client.input({
      runtime,
      payload: {
        kind: "create_message",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    await waitFor(() => finished);
    expect(request).toHaveBeenCalledTimes(1);
    await waitFor(() => getActiveRuntime()?.processServicesStarted === true);
    const task = addTask({
      agent_id: agent.id,
      conversation_id: conversation.id,
      name: "Reminder",
      description: "Scheduled turn",
      cron: "0 0 * * *",
      recurring: false,
      prompt: "Check in",
      scheduled_for: new Date(Date.now() - 1_000),
    }).task;
    primary.stdin.end();
    expect(await primary.exited).toBe(0);
    await primaryOutput;
    expect(getTask(task.id)?.status).toBe("active");
    expect(request).toHaveBeenCalledTimes(1);
    const listener = getActiveRuntime();
    if (!listener) throw new Error("Missing active server runtime");
    const scoped = getOrCreateScopedRuntime(
      listener,
      agent.id,
      conversation.id,
    );
    for (const tick of ticks) tick();
    await new Promise((resolve) => setImmediate(resolve));
    await scoped.messageQueue;
    expect(request).toHaveBeenCalledTimes(2);
    expect(
      readCronRunLogEntries(getCronRunLogPath(task.id)).map(
        (entry) => entry.outcome,
      ),
    ).toEqual(["queued", "delivered"]);
    expect(request.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("Check in"),
          }),
        ]),
      }),
    );
  } finally {
    globalThis.setInterval = originalSetInterval;
    primary.kill();
    await primary.exited;
    await primaryOutput;
    client.close();
    await server.close();
    request.mockRestore();
    __testSetBackend(null);
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
    await rm(home, { recursive: true, force: true });
  }
}, 20_000);
