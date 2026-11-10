import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { expandDreamCommand } from "@/cli/subcommands/dream";

describe("expandDreamCommand", () => {
  test("leaves other commands unchanged", () => {
    const args = ["-p", "hello", "--model", "opus"];
    expect(expandDreamCommand(args)).toBe(args);
  });

  test("creates a new MemFS agent and sends the dream prompt", () => {
    const [flag, prompt, ...rest] = expandDreamCommand([
      "dream",
      "trajectories",
      "--model",
      "opus",
    ]);
    expect(flag).toBe("-p");
    expect(rest).toEqual([
      "--new-agent",
      "--memfs",
      "--base-tools",
      "none",
      "--yolo",
      "--model",
      "opus",
    ]);
    expect(prompt).toContain(`"corpus": "${resolve("trajectories")}"`);
    expect(prompt).not.toContain("{{corpus}}");
    expect(prompt).toContain("Call the Workflow tool with `wait: true`");
  });
});
