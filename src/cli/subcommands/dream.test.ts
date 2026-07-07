import { describe, expect, test } from "bun:test";
import { runDreamSubcommand } from "./dream";

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
      expect(output).toContain("--to");
      expect(output).toContain("--instruction");
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
});
