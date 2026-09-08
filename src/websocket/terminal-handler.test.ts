import { describe, expect, test } from "bun:test";
import { makeOutputBatcher } from "./terminal-handler";

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

  test("lets terminal exit follow the final output", () => {
    const messages: string[] = [];
    const batcher = makeOutputBatcher(() => messages.push("terminal_output"));

    batcher.push("tail");
    batcher.flush();
    messages.push("terminal_exited");

    expect(messages).toEqual(["terminal_output", "terminal_exited"]);
  });
});
