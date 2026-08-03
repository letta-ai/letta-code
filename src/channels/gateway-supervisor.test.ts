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
  const script = join(dir, "fixture.ts");
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
    console.log("CHANNEL_GATEWAY_READY");
    createInterface({ input: process.stdin }).on("line", (line) => {
      const envelope = JSON.parse(line);
      console.log("CHANNEL_GATEWAY_RESPONSE " + JSON.stringify({
        requestId: envelope.requestId,
        response: { kind: "text", text: envelope.command.args ?? "none" },
      }));
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
    launcher: { command: process.execPath, args: [script] },
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
  expect(await readFile(join(dir, "stopped"), "utf8")).toBe("yes");
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
    launcher: { command: process.execPath, args: [script] },
    onUnexpectedExit: (error) => reportUnexpectedExit?.(error),
  });

  await expect(unexpectedExit).resolves.toMatchObject({
    message: expect.stringContaining("exited unexpectedly (7)"),
  });
  await supervisor.close();
});
