import { describe, expect, test } from "bun:test";
import { parseDreamArgs, runDreamSubcommand } from "./dream";

function captureConsole(): {
  errors: string[];
  logs: string[];
  restore: () => void;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => {
    logs.push(String(message));
  };
  console.error = (message?: unknown) => {
    errors.push(String(message));
  };
  return {
    errors,
    logs,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

describe("dream subcommand", () => {
  test("prints usage for --help", async () => {
    const captured = captureConsole();
    try {
      const exitCode = await runDreamSubcommand(["--help"]);
      expect(exitCode).toBe(0);
      const output = captured.logs.join("\n");
      expect(output).toContain("Usage:");
      expect(output).toContain("letta dream");
      expect(output).toContain("--memory");
      expect(output).toContain("--from");
      expect(output).toContain("--model");
      expect(output).toContain("--to");
      expect(output).toContain("--instruction");
      expect(output).toContain("--prompt");
      expect(output).toContain("--system");
    } finally {
      captured.restore();
    }
  });

  test("prints usage for help action", async () => {
    const captured = captureConsole();
    try {
      const exitCode = await runDreamSubcommand(["help"]);
      expect(exitCode).toBe(0);
      expect(captured.logs.join("\n")).toContain("Usage:");
    } finally {
      captured.restore();
    }
  });

  test("rejects unknown positionals", async () => {
    const captured = captureConsole();
    try {
      const exitCode = await runDreamSubcommand(["bogus"]);
      expect(exitCode).toBe(1);
      expect(captured.errors.join("\n")).toContain("Unknown argument: bogus");
    } finally {
      captured.restore();
    }
  });

  test("rejects unknown flags", async () => {
    const captured = captureConsole();
    try {
      const exitCode = await runDreamSubcommand(["--bogus"]);
      expect(exitCode).toBe(1);
      expect(captured.errors.join("\n")).toContain("Error:");
    } finally {
      captured.restore();
    }
  });

  test("accepts an explicit reflection model", () => {
    const parsed = parseDreamArgs(["--model", "zai/glm-5.2"]);

    expect(parsed.values.model).toBe("zai/glm-5.2");
  });

  test("accepts a reflection task prompt override", () => {
    const parsed = parseDreamArgs(["--prompt", "Distill task X notes."]);

    expect(parsed.values.prompt).toBe("Distill task X notes.");
  });

  test("accepts a reflection system prompt override", () => {
    const parsed = parseDreamArgs(["--system", "You write terse notes."]);

    expect(parsed.values.system).toBe("You write terse notes.");
  });
});
