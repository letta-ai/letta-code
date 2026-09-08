import { afterEach, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import {
  handleTerminalInput,
  handleTerminalSpawn,
  killAllTerminals,
  makeOutputBatcher,
} from "./terminal-handler";

afterEach(() => killAllTerminals());

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("timed out waiting for terminal");
    await Bun.sleep(10);
  }
}

describe("makeOutputBatcher", () => {
  test("flushes buffered output synchronously and only once", async () => {
    const flushed: string[] = [];
    const batcher = makeOutputBatcher((data) => flushed.push(data));

    batcher.push("tail ");
    batcher.push("output");
    batcher.flush();
    batcher.flush();

    expect(flushed).toEqual(["tail output"]);

    await Bun.sleep(25);
    expect(flushed).toEqual(["tail output"]);
  });

  test("Bun emits buffered PTY output before terminal exit", async () => {
    const messages: Array<Record<string, unknown>> = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send: (raw: string) => messages.push(JSON.parse(raw)),
    } as unknown as WebSocket;
    const terminalId = "bun-exit-order";
    const connectionId = "terminal-handler-test";

    handleTerminalSpawn(
      { terminal_id: terminalId, cols: 80, rows: 24 },
      socket,
      process.cwd(),
      connectionId,
    );
    await waitFor(() =>
      messages.some(({ type }) => type === "terminal_spawned"),
    );
    handleTerminalInput(
      { terminal_id: terminalId, data: "printf '__FINAL_TAIL__'; exit\n" },
      connectionId,
    );
    await waitFor(() =>
      messages.some(({ type }) => type === "terminal_exited"),
    );

    const exitIndex = messages.findIndex(
      ({ type }) => type === "terminal_exited",
    );
    const outputBeforeExit = messages
      .slice(0, exitIndex)
      .filter(({ type }) => type === "terminal_output")
      .map(({ data }) => String(data))
      .join("");
    expect(outputBeforeExit).toContain("__FINAL_TAIL__");
    expect(
      messages
        .slice(exitIndex + 1)
        .some(({ type }) => type === "terminal_output"),
    ).toBe(false);
  });

  test("lets terminal exit follow the final output", () => {
    const messages: string[] = [];
    const batcher = makeOutputBatcher(() => messages.push("terminal_output"));

    batcher.push("tail");
    batcher.flush();
    messages.push("terminal_exited");

    expect(messages).toEqual(["terminal_output", "terminal_exited"]);
  });
});
