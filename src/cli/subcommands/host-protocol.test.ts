import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  createStdioHostProtocol,
  HOST_COMMAND_PREFIX,
  HOST_PROTOCOL_PREFIX,
  type HostProtocolEvent,
  startHostParentWatchdog,
  startStdioHostCommandListener,
} from "@/cli/subcommands/host-protocol";

function captureProtocol(): {
  readEvents: () => HostProtocolEvent[];
  protocol: ReturnType<typeof createStdioHostProtocol>;
} {
  const lines: string[] = [];
  const protocol = createStdioHostProtocol((line) => lines.push(line));

  return {
    protocol,
    readEvents: () =>
      lines.map((line) => {
        expect(line.startsWith(HOST_PROTOCOL_PREFIX)).toBe(true);
        return JSON.parse(
          line.slice(HOST_PROTOCOL_PREFIX.length),
        ) as HostProtocolEvent;
      }),
  };
}

describe("stdio host protocol", () => {
  test("accepts only a versioned shutdown command from its host", async () => {
    const input = new PassThrough();
    let shutdowns = 0;
    const stop = startStdioHostCommandListener(() => {
      shutdowns += 1;
    }, input);

    input.write("ordinary input\n");
    input.write(`${HOST_COMMAND_PREFIX}{"version":2,"type":"shutdown"}\n`);
    input.write(`${HOST_COMMAND_PREFIX}{"version":1,"type":"shutdown"}\n`);
    input.write(`${HOST_COMMAND_PREFIX}{"version":1,"type":"shutdown"}\n`);
    await Bun.sleep(0);
    stop();

    expect(shutdowns).toBe(1);
  });

  test("rejects an invalid supervising process ID", () => {
    expect(() => startHostParentWatchdog(undefined, "not-a-pid")).toThrow(
      "must be a valid process ID",
    );
  });

  test("emits prefixed, versioned ready and processing events from statuses", () => {
    const { readEvents, protocol } = captureProtocol();

    protocol.emitStatus("idle", "conn-1");
    protocol.emitStatus("receiving", "conn-1");
    protocol.emitStatus("processing", "conn-1");
    protocol.emitStatus("idle", "conn-1");

    expect(readEvents()).toEqual([
      { version: 1, type: "ready", connectionId: "conn-1" },
      { version: 1, type: "processing", connectionId: "conn-1" },
      { version: 1, type: "ready", connectionId: "conn-1" },
    ]);
  });

  test("deduplicates connected and idle ready notifications", () => {
    const { readEvents, protocol } = captureProtocol();

    protocol.emitReady("conn-1");
    protocol.emitStatus("idle", "conn-1");

    expect(readEvents()).toEqual([
      { version: 1, type: "ready", connectionId: "conn-1" },
    ]);
  });

  test("emits reconnecting and fatal event details", () => {
    const { readEvents, protocol } = captureProtocol();

    protocol.emitReconnecting("conn-2", 3, 2_500);
    protocol.emitFatal("listener_start_failed", "registration failed");

    expect(readEvents()).toEqual([
      {
        version: 1,
        type: "reconnecting",
        connectionId: "conn-2",
        attempt: 3,
        retryInMs: 2_500,
      },
      {
        version: 1,
        type: "fatal",
        reason: "listener_start_failed",
        message: "registration failed",
      },
    ]);
  });
});
