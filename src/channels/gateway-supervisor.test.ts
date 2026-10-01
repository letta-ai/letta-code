import { afterEach, expect, test } from "bun:test";
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  type ChannelGatewayLifecycleEvent,
  startChannelGatewaySupervisor,
} from "./gateway-supervisor";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function writeGatewayFixture(
  source: string | ((dir: string) => string),
): Promise<{
  dir: string;
  script: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "channel-gateway-supervisor-"));
  tempDirs.push(dir);
  const script = join(dir, "fixture.mjs");
  await writeFile(
    script,
    typeof source === "function" ? source(dir) : source,
    "utf8",
  );
  return { dir, script };
}

function createControllableGatewayProcess(): {
  child: ChildProcess;
  stdout: PassThrough;
  exit: (code?: number, signal?: NodeJS.Signals | null) => void;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as ChildProcess;
  let exited = false;
  const exit = (code = 0, signal: NodeJS.Signals | null = null): void => {
    if (exited) return;
    exited = true;
    Object.assign(child, { exitCode: code });
    child.emit("exit", code, signal);
  };
  Object.assign(child, {
    pid: 1234,
    stdin,
    stdout,
    stderr,
    exitCode: null,
    kill: (signal?: NodeJS.Signals | number) => {
      exit(0, typeof signal === "string" ? signal : null);
      return true;
    },
  });
  return { child, stdout, exit };
}

function createGatewayFixtureProcess(): {
  spawnProcess: typeof spawn;
  getKillSignal: () => NodeJS.Signals | number | undefined;
} {
  // Bun 1.3.0 on Windows can stall when the test process writes to a spawned
  // child's stdin pipe. Model the process boundary in memory so this protocol
  // test remains deterministic; the unexpected-exit test below still launches
  // a real Node child on every platform.
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as ChildProcess;
  let killSignal: NodeJS.Signals | number | undefined;
  Object.assign(child, {
    pid: 1234,
    stdin,
    stdout,
    stderr,
    exitCode: null,
    kill: (signal?: NodeJS.Signals | number) => {
      killSignal = signal;
      Object.assign(child, { exitCode: 0 });
      child.emit("exit", 0, signal ?? null);
      return true;
    },
  });
  let inputBuffer = "";
  stdin.on("data", (chunk: Buffer) => {
    inputBuffer += chunk.toString("utf8");
    const lines = inputBuffer.split("\n");
    inputBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const envelope = JSON.parse(line) as {
        requestId: string;
        command: { args?: string };
      };
      stdout.write(
        `CHANNEL_GATEWAY_RESPONSE ${JSON.stringify({
          requestId: envelope.requestId,
          response: {
            kind: "text",
            text: envelope.command.args ?? "none",
          },
        })}\r\n`,
      );
    }
  });
  const spawnProcess = (() => {
    queueMicrotask(() => stdout.write("CHANNEL_GATEWAY_READY\r\n"));
    return child;
  }) as typeof spawn;
  return { spawnProcess, getKillSignal: () => killSignal };
}

test("supervisor waits for readiness, carries service commands, and shuts down", async () => {
  const fixture = createGatewayFixtureProcess();
  const supervisor = await startChannelGatewaySupervisor({
    appServerUrl: "ws://127.0.0.1:1/ws",
    channelNames: ["telegram"],
    launcher: { command: "fixture" },
    spawnProcess: fixture.spawnProcess,
  });

  await expect(
    supervisor.request({
      kind: "slash_command",
      command: "channels",
      args: "status",
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
    }),
  ).resolves.toEqual({ kind: "text", text: "status" });

  await supervisor.close();
  expect(fixture.getKillSignal()).toBe("SIGTERM");
});

test("supervisor restarts after an unexpected post-ready exit", async () => {
  const { script } = await writeGatewayFixture((dir) => {
    const startsPath = join(dir, "starts.txt");
    return `
      import { readFileSync, writeFileSync } from "node:fs";
      const startsPath = ${JSON.stringify(startsPath)};
      let starts = 0;
      try { starts = Number(readFileSync(startsPath, "utf8")); } catch {}
      starts += 1;
      writeFileSync(startsPath, String(starts));
      console.log("CHANNEL_GATEWAY_READY");
      if (starts === 1) setTimeout(() => process.exit(7), 20);
      else setInterval(() => {}, 1000);
    `;
  });
  let reportUnexpectedExit: ((error: Error) => void) | undefined;
  const unexpectedExit = new Promise<Error>((resolve) => {
    reportUnexpectedExit = resolve;
  });
  let startedCount = 0;
  let reportRestarted: (() => void) | undefined;
  const restarted = new Promise<void>((resolve) => {
    reportRestarted = resolve;
  });
  const supervisor = await startChannelGatewaySupervisor({
    appServerUrl: "ws://127.0.0.1:1/ws",
    channelNames: ["telegram"],
    launcher: { command: "node", args: [script] },
    onLog: (message) => {
      if (!message.includes("started pid=")) return;
      startedCount += 1;
      if (startedCount === 2) reportRestarted?.();
    },
    onUnexpectedExit: (error) => reportUnexpectedExit?.(error),
  });

  await expect(unexpectedExit).resolves.toMatchObject({
    message: expect.stringContaining("exited unexpectedly (7)"),
  });
  const didRestart = await Promise.race([
    restarted.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  expect(didRestart).toBe(true);
  await supervisor.close();
});

test("supervisor stops a crash loop after the restart budget is exhausted", async () => {
  let spawnCount = 0;
  const spawnProcess = (() => {
    spawnCount += 1;
    const process = createControllableGatewayProcess();
    queueMicrotask(() => {
      process.stdout.write("CHANNEL_GATEWAY_READY\n");
      setTimeout(() => process.exit(7), 0);
    });
    return process.child;
  }) as typeof spawn;
  let reportExhausted: ((error: Error) => void) | undefined;
  const exhausted = new Promise<Error>((resolve) => {
    reportExhausted = resolve;
  });
  let unexpectedExitCount = 0;
  const logs: string[] = [];
  const lifecycleEvents: ChannelGatewayLifecycleEvent[] = [];
  const supervisor = await startChannelGatewaySupervisor({
    appServerUrl: "ws://127.0.0.1:1/ws",
    channelNames: ["telegram"],
    launcher: { command: "fixture" },
    spawnProcess,
    restartPolicy: {
      maxAttempts: 2,
      initialDelayMs: 2,
      maxDelayMs: 3,
      stableAfterMs: 1000,
    },
    onLog: (message) => logs.push(message),
    onLifecycleEvent: (event) => lifecycleEvents.push(event),
    onUnexpectedExit: () => {
      unexpectedExitCount += 1;
    },
    onRestartExhausted: (error) => reportExhausted?.(error),
  });

  await expect(exhausted).resolves.toMatchObject({
    message: expect.stringContaining("restart attempts exhausted (2)"),
  });
  expect(spawnCount).toBe(3);
  expect(unexpectedExitCount).toBe(3);
  expect(logs).toContain("[ChannelGateway] restart attempt 1/2 in 2ms");
  expect(logs).toContain("[ChannelGateway] restart attempt 2/2 in 3ms");
  expect(lifecycleEvents.map((event) => event.kind)).toEqual([
    "exit",
    "restart_scheduled",
    "restart_ready",
    "exit",
    "restart_scheduled",
    "restart_ready",
    "exit",
    "restart_exhausted",
  ]);
  expect(lifecycleEvents[0]).toMatchObject({
    restartAttempt: 0,
    maxRestartAttempts: 2,
    exitCode: 7,
    reachedReady: true,
  });
  await supervisor.close();
});

test("supervisor resets the restart budget only after a stable period", async () => {
  let spawnCount = 0;
  let reportThirdStart: (() => void) | undefined;
  const thirdStart = new Promise<void>((resolve) => {
    reportThirdStart = resolve;
  });
  const spawnProcess = (() => {
    spawnCount += 1;
    const process = createControllableGatewayProcess();
    const thisSpawn = spawnCount;
    queueMicrotask(() => {
      process.stdout.write("CHANNEL_GATEWAY_READY\n");
      if (thisSpawn === 1) setTimeout(() => process.exit(7), 0);
      if (thisSpawn === 2) setTimeout(() => process.exit(7), 20);
      if (thisSpawn === 3) reportThirdStart?.();
    });
    return process.child;
  }) as typeof spawn;
  const supervisor = await startChannelGatewaySupervisor({
    appServerUrl: "ws://127.0.0.1:1/ws",
    channelNames: ["telegram"],
    launcher: { command: "fixture" },
    spawnProcess,
    restartPolicy: {
      maxAttempts: 1,
      initialDelayMs: 1,
      maxDelayMs: 1,
      stableAfterMs: 5,
    },
  });

  const restartedAfterStable = await Promise.race([
    thirdStart.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  expect(restartedAfterStable).toBe(true);
  expect(spawnCount).toBe(3);
  await supervisor.close();
});

test("an in-flight command fails once before the replacement becomes available", async () => {
  let spawnCount = 0;
  let reportReplacementReady: (() => void) | undefined;
  const replacementReady = new Promise<void>((resolve) => {
    reportReplacementReady = resolve;
  });
  const spawnProcess = (() => {
    spawnCount += 1;
    const process = createControllableGatewayProcess();
    const thisSpawn = spawnCount;
    queueMicrotask(() => {
      process.stdout.write("CHANNEL_GATEWAY_READY\n");
      if (thisSpawn === 1) {
        process.child.stdin?.once("data", () => process.exit(7));
      } else {
        reportReplacementReady?.();
      }
    });
    return process.child;
  }) as typeof spawn;
  const supervisor = await startChannelGatewaySupervisor({
    appServerUrl: "ws://127.0.0.1:1/ws",
    channelNames: ["telegram"],
    launcher: { command: "fixture" },
    spawnProcess,
    restartPolicy: { initialDelayMs: 1, maxDelayMs: 1 },
  });

  let settlementCount = 0;
  const request = supervisor
    .request({
      kind: "slash_command",
      command: "channels",
      args: "status",
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
    })
    .then(
      () => {
        settlementCount += 1;
        throw new Error("Expected command to fail when its child exited");
      },
      (error: unknown) => {
        settlementCount += 1;
        throw error;
      },
    );
  await expect(request).rejects.toMatchObject({
    message: expect.stringContaining("exited unexpectedly (7)"),
  });
  await replacementReady;
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(settlementCount).toBe(1);
  await supervisor.close();
});

test("a replacement that ignores SIGTERM is force-killed and consumes the next retry", async () => {
  let spawnCount = 0;
  let reportThirdReady: (() => void) | undefined;
  const thirdReady = new Promise<void>((resolve) => {
    reportThirdReady = resolve;
  });
  const spawnProcess = (() => {
    spawnCount += 1;
    const process = createControllableGatewayProcess();
    const thisSpawn = spawnCount;
    if (thisSpawn === 2) {
      Object.assign(process.child, {
        kill: (signal?: NodeJS.Signals | number) => {
          if (signal !== "SIGKILL") return true;
          process.exit(1, "SIGKILL");
          return true;
        },
      });
    }
    queueMicrotask(() => {
      if (thisSpawn === 2) return;
      process.stdout.write("CHANNEL_GATEWAY_READY\n");
      if (thisSpawn === 1) setTimeout(() => process.exit(7), 0);
      if (thisSpawn === 3) reportThirdReady?.();
    });
    return process.child;
  }) as typeof spawn;
  const supervisor = await startChannelGatewaySupervisor({
    appServerUrl: "ws://127.0.0.1:1/ws",
    channelNames: ["telegram"],
    launcher: { command: "fixture" },
    spawnProcess,
    restartPolicy: {
      maxAttempts: 2,
      initialDelayMs: 1,
      maxDelayMs: 1,
      readyTimeoutMs: 5,
      shutdownTimeoutMs: 5,
      stableAfterMs: 1000,
    },
  });

  await thirdReady;
  expect(spawnCount).toBe(3);
  await supervisor.close();
});

test("a replacement that never becomes ready consumes the next retry", async () => {
  let spawnCount = 0;
  let reportThirdReady: (() => void) | undefined;
  const thirdReady = new Promise<void>((resolve) => {
    reportThirdReady = resolve;
  });
  const spawnProcess = (() => {
    spawnCount += 1;
    const process = createControllableGatewayProcess();
    const thisSpawn = spawnCount;
    queueMicrotask(() => {
      if (thisSpawn === 2) return;
      process.stdout.write("CHANNEL_GATEWAY_READY\n");
      if (thisSpawn === 1) setTimeout(() => process.exit(7), 0);
      if (thisSpawn === 3) reportThirdReady?.();
    });
    return process.child;
  }) as typeof spawn;
  const supervisor = await startChannelGatewaySupervisor({
    appServerUrl: "ws://127.0.0.1:1/ws",
    channelNames: ["telegram"],
    launcher: { command: "fixture" },
    spawnProcess,
    restartPolicy: {
      maxAttempts: 2,
      initialDelayMs: 1,
      maxDelayMs: 1,
      readyTimeoutMs: 5,
      stableAfterMs: 1000,
    },
  });

  await thirdReady;
  expect(spawnCount).toBe(3);
  await supervisor.close();
});

test("closing during restart backoff cancels the replacement", async () => {
  let spawnCount = 0;
  let reportUnexpectedExit: (() => void) | undefined;
  const unexpectedExit = new Promise<void>((resolve) => {
    reportUnexpectedExit = resolve;
  });
  const spawnProcess = (() => {
    spawnCount += 1;
    const process = createControllableGatewayProcess();
    queueMicrotask(() => {
      process.stdout.write("CHANNEL_GATEWAY_READY\n");
      setTimeout(() => process.exit(7), 0);
    });
    return process.child;
  }) as typeof spawn;
  const supervisor = await startChannelGatewaySupervisor({
    appServerUrl: "ws://127.0.0.1:1/ws",
    channelNames: ["telegram"],
    launcher: { command: "fixture" },
    spawnProcess,
    restartPolicy: { initialDelayMs: 50, maxDelayMs: 50 },
    onUnexpectedExit: () => reportUnexpectedExit?.(),
  });

  await unexpectedExit;
  await supervisor.close();
  await new Promise((resolve) => setTimeout(resolve, 75));
  expect(spawnCount).toBe(1);
});
