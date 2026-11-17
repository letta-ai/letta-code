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
    expect(prompt).toContain("worktree add");
  });

  test("--dynamic sends only the goal and budget, not the workflow", () => {
    const [, prompt, ...rest] = expandDreamCommand([
      "dream",
      "trajectories",
      "--dynamic",
      "--budget-usd",
      "250",
      "--model",
      "opus",
    ]);
    expect(rest.slice(-2)).toEqual(["--model", "opus"]);
    expect(rest).not.toContain("--dynamic");
    expect(prompt).toContain(resolve("trajectories"));
    expect(prompt).toContain("Your budget is $250 (USD)");
    expect(prompt).toContain("maxCostUsd");
    expect(prompt).not.toContain("worktree add");
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
    expect(process.env.LETTA_RUN_MAX_COST_USD).toBe("250");
    expect(prompt).toContain(String(process.env.LETTA_RUN_SPEND_FILE));
  });
});
