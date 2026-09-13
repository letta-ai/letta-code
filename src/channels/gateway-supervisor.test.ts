import { afterEach, expect, test } from "bun:test";
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { startChannelGatewaySupervisor } from "./gateway-supervisor";

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

test("supervisor reports an unexpected post-ready exit without restarting", async () => {
  const { script } = await writeGatewayFixture(`
    console.log("CHANNEL_GATEWAY_READY");
    setTimeout(() => process.exit(7), 20);
  `);
  let reportUnexpectedExit: ((error: Error) => void) | undefined;
  const unexpectedExit = new Promise<Error>((resolve) => {
    reportUnexpectedExit = resolve;
  });
  const supervisor = await startChannelGatewaySupervisor({
    appServerUrl: "ws://127.0.0.1:1/ws",
    channelNames: ["telegram"],
    launcher: { command: "node", args: [script] },
    onUnexpectedExit: (error) => reportUnexpectedExit?.(error),
  });

  await expect(unexpectedExit).resolves.toMatchObject({
    message: expect.stringContaining("exited unexpectedly (7)"),
  });
  await supervisor.close();
});
