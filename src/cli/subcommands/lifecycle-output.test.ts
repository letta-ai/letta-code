import { describe, expect, test } from "bun:test";
import {
  createServerLifecycleOutput,
  resolveServerLifecycleOutput,
} from "@/cli/subcommands/lifecycle-output";

describe("server lifecycle output", () => {
  test("emits protocol-versioned JSON lines without runtime payloads", () => {
    const lines: string[] = [];
    const output = createServerLifecycleOutput((line) => lines.push(line));

    output.emit("connected");
    output.emitListenerStatus("idle");
    output.emitListenerStatus("receiving");
    output.emitListenerStatus("processing");
    output.emit("reconnecting");
    output.emit("error");

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { lettaLifecycleProtocol: 1, state: "connected" },
      { lettaLifecycleProtocol: 1, state: "idle" },
      { lettaLifecycleProtocol: 1, state: "working" },
      { lettaLifecycleProtocol: 1, state: "reconnecting" },
      { lettaLifecycleProtocol: 1, state: "error" },
    ]);
    expect(lines.join("\n")).not.toContain("connectionId");
    expect(lines.join("\n")).not.toContain("message");
  });

  test("deduplicates repeated state transitions", () => {
    const lines: string[] = [];
    const output = createServerLifecycleOutput((line) => lines.push(line));

    output.emit("idle");
    output.emit("idle");
    output.emitListenerStatus("idle");

    expect(lines).toHaveLength(1);
  });

  test("validates supervisor output mode without enabling debug payloads", () => {
    expect(resolveServerLifecycleOutput("yaml", false)).toMatchObject({
      output: null,
      error: expect.stringContaining('expected "jsonl"'),
    });
    expect(resolveServerLifecycleOutput("jsonl", true)).toMatchObject({
      output: null,
      error: expect.stringContaining("cannot be combined"),
    });
    expect(resolveServerLifecycleOutput("jsonl", false)).toMatchObject({
      error: null,
    });
  });
});
