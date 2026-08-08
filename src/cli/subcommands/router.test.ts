import { describe, expect, test } from "bun:test";
import {
  runSubcommand,
  subcommandNeedsEarlyBackendMode,
} from "@/cli/subcommands/router";

describe("subcommand router", () => {
  test("routes version subcommand before TUI startup", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      const exitCode = await runSubcommand(["version"]);

      expect(exitCode).toBe(0);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(/^\d+\.\d+\.\d+ .*\(Letta Code\)$/);
    } finally {
      console.log = originalLog;
    }
  });

  test("routes connect subcommand", async () => {
    const exitCode = await runSubcommand(["connect", "help"]);
    expect(exitCode).toBe(0);
  });

  test("shows unified server help without starting a server", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      const exitCode = await runSubcommand(["server", "--help"]);

      expect(exitCode).toBe(0);
      expect(messages.join("\n")).toContain("letta server [remote options]");
      expect(messages.join("\n")).toContain(
        "letta server --listen [url] [App Server options]",
      );
    } finally {
      console.log = originalLog;
    }
  });

  test("keeps app-server as a deprecated alias", async () => {
    const messages: string[] = [];
    const warnings: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };
    console.error = (message?: unknown) => {
      warnings.push(String(message));
    };

    try {
      const exitCode = await runSubcommand(["app-server", "--help"]);

      expect(exitCode).toBe(0);
      expect(messages.join("\n")).toContain(
        "letta server --listen [url] [App Server options]",
      );
      expect(warnings).toEqual([
        "Warning: `letta app-server` is deprecated. Use `letta server --listen` instead.",
      ]);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });

  test("routes mods help", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      const exitCode = await runSubcommand(["mods", "help"]);

      expect(exitCode).toBe(0);
      expect(messages.join("\n")).toContain("Usage:");
      expect(messages.join("\n")).toContain("letta mods list");
    } finally {
      console.log = originalLog;
    }
  });

  test("routes dream help", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      const exitCode = await runSubcommand(["dream", "--help"]);

      expect(exitCode).toBe(0);
      expect(messages.join("\n")).toContain("Usage:");
      expect(messages.join("\n")).toContain("letta dream");
    } finally {
      console.log = originalLog;
    }
  });

  test("routes environments help", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      const exitCode = await runSubcommand(["envs", "help"]);

      expect(exitCode).toBe(0);
      expect(messages.join("\n")).toContain("letta environments list");
    } finally {
      console.log = originalLog;
    }
  });

  test("identifies backend-aware subcommands for early backend selection", () => {
    expect(subcommandNeedsEarlyBackendMode("app-server")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("connect")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("dream")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("server")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("environments")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("envs")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("memory")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("mods")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("version")).toBe(false);
    expect(subcommandNeedsEarlyBackendMode("backend")).toBe(false);
    expect(subcommandNeedsEarlyBackendMode(undefined)).toBe(false);
  });
});
