import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("supervisor waits for readiness, carries service commands, and shuts down", async () => {
  const { dir, script } = await writeGatewayFixture(
    (fixtureDir) => `
    import { appendFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    process.stdout.write("CHANNEL_GATEWAY_READY\\r\\n");
    createInterface({ input: process.stdin }).on("line", (line) => {
      const envelope = JSON.parse(line);
      process.stdout.write("CHANNEL_GATEWAY_RESPONSE " + JSON.stringify({
        requestId: envelope.requestId,
        response: { kind: "text", text: envelope.command.args ?? "none" },
      }) + "\\r\\n");
    });
    process.on("SIGTERM", () => {
      appendFileSync(${JSON.stringify(join(fixtureDir, "stopped"))}, "yes");
      process.exit(0);
    });
  `,
  );
  const supervisor = await startChannelGatewaySupervisor({
    appServerUrl: "ws://127.0.0.1:1/ws",
    channelNames: ["telegram"],
    // The distributed CLI runs this child under Node. Using Node here also
    // avoids Bun 1.3.0's Windows child-process readline pipe bug.
    launcher: { command: "node", args: [script] },
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
  // Windows terminates child processes directly for SIGTERM, so the child
  // cannot run a signal handler to write the graceful-shutdown marker.
  if (process.platform !== "win32") {
    expect(await readFile(join(dir, "stopped"), "utf8")).toBe("yes");
  }
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
