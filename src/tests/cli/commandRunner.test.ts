import { describe, expect, test } from "bun:test";
import {
  handleMcpUsage,
  setActiveCommandId as setActiveMcpCommandId,
} from "../../cli/commands/mcp";
import {
  addCommandResult,
  setActiveCommandId as setActiveProfileCommandId,
  updateCommandResult,
} from "../../cli/commands/profile";
import { createCommandRunner } from "../../cli/commands/runner";
import { createBuffers } from "../../cli/helpers/accumulator";

describe("commandRunner", () => {
  test("start/finish writes a single command line", () => {
    const buffers = createBuffers();
    const buffersRef = { current: buffers };
    let refreshCount = 0;
    const runner = createCommandRunner({
      buffersRef,
      refreshDerived: () => {
        refreshCount += 1;
      },
      createId: () => "cmd-1",
    });

    const cmd = runner.start("/model", "Opening model selector...");
    expect(cmd.id).toBe("cmd-1");
    expect(buffers.order).toEqual(["cmd-1"]);
    expect(buffers.byId.get("cmd-1")).toMatchObject({
      kind: "command",
      input: "/model",
      output: "Opening model selector...",
      phase: "running",
    });

    cmd.finish("Done", true);
    expect(buffers.byId.get("cmd-1")).toMatchObject({
      kind: "command",
      input: "/model",
      output: "Done",
      phase: "finished",
      success: true,
    });
    expect(refreshCount).toBeGreaterThan(0);
  });

  test("getHandle preserves existing input and order", () => {
    const buffers = createBuffers();
    const buffersRef = { current: buffers };
    buffers.byId.set("cmd-1", {
      kind: "command",
      id: "cmd-1",
      input: "/connect",
      output: "Starting...",
      phase: "running",
    });
    buffers.order.push("cmd-1");

    const runner = createCommandRunner({
      buffersRef,
      refreshDerived: () => {},
      createId: () => "cmd-ignored",
    });

    const cmd = runner.getHandle("cmd-1", "/connect codex");
    cmd.update({ output: "Still running...", phase: "running" });

    const line = buffers.byId.get("cmd-1");
    expect(line).toMatchObject({
      kind: "command",
      input: "/connect",
      output: "Still running...",
      phase: "running",
    });
    expect(buffers.order).toEqual(["cmd-1"]);
  });

  test("onCommandFinished fires once on running->finished transition", () => {
    const buffers = createBuffers();
    const buffersRef = { current: buffers };
    const finishedEvents: Array<{ input: string; output: string }> = [];
    const runner = createCommandRunner({
      buffersRef,
      refreshDerived: () => {},
      createId: () => "cmd-1",
      onCommandFinished: (event) => {
        finishedEvents.push({ input: event.input, output: event.output });
      },
    });

    const cmd = runner.start("/model", "Opening model selector...");
    cmd.update({ output: "Still opening...", phase: "running" });
    cmd.finish("Switched", true);
    cmd.finish("Switched again", true);

    expect(finishedEvents).toEqual([{ input: "/model", output: "Switched" }]);
  });
});

describe("command input preservation in handlers", () => {
  test("mcp usage keeps original input when reusing command id", () => {
    const buffers = createBuffers();
    const buffersRef = { current: buffers };
    buffers.byId.set("cmd-1", {
      kind: "command",
      id: "cmd-1",
      input: "/mcp",
      output: "",
      phase: "running",
    });
    buffers.order.push("cmd-1");

    setActiveMcpCommandId("cmd-1");
    handleMcpUsage(
      {
        buffersRef,
        refreshDerived: () => {},
        setCommandRunning: () => {},
      },
      "/mcp add",
    );
    setActiveMcpCommandId(null);

    const line = buffers.byId.get("cmd-1");
    expect(line).toMatchObject({
      kind: "command",
      input: "/mcp",
    });
    expect(line?.kind).toBe("command");
    if (line && line.kind === "command") {
      expect(line.output).toContain("Usage: /mcp");
    }
  });

  test("profile updates keep original input when reusing command id", () => {
    const buffers = createBuffers();
    const buffersRef = { current: buffers };
    buffers.byId.set("cmd-1", {
      kind: "command",
      id: "cmd-1",
      input: "/profile",
      output: "",
      phase: "running",
    });
    buffers.order.push("cmd-1");

    setActiveProfileCommandId("cmd-1");
    addCommandResult(
      buffersRef,
      () => {},
      "/profile save test",
      "Saving...",
      false,
      "running",
    );
    updateCommandResult(
      buffersRef,
      () => {},
      "cmd-1",
      "/profile delete test",
      "Done",
      true,
      "finished",
    );
    setActiveProfileCommandId(null);

    const line = buffers.byId.get("cmd-1");
    expect(line).toMatchObject({
      kind: "command",
      input: "/profile",
      output: "Done",
      phase: "finished",
      success: true,
    });
  });
});
