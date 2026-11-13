import { describe, expect, test } from "bun:test";
import type { MonitorState } from "@/backend/api/monitors";
import {
  runSubcommand,
  subcommandNeedsEarlyBackendMode,
} from "@/cli/subcommands/router";
import { runMonitorsSubcommand } from "./monitors";

describe("subcommand router", () => {
  test("routes monitors help before TUI startup", async () => {
    expect(subcommandNeedsEarlyBackendMode("monitors")).toBe(true);
    expect(await runSubcommand(["monitors", "--help"])).toBe(0);
  });

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

  test("routes steps help with early backend selection", async () => {
    expect(subcommandNeedsEarlyBackendMode("steps")).toBe(true);
    expect(await runSubcommand(["steps", "--help"])).toBe(0);
  });

  test("routes connect subcommand", async () => {
    const exitCode = await runSubcommand(["connect", "help"]);
    expect(exitCode).toBe(0);
  });

  test("routes permissions help before TUI startup", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      expect(subcommandNeedsEarlyBackendMode("permissions")).toBe(true);
      expect(await runSubcommand(["permissions", "--help"])).toBe(0);
      expect(messages.join("\n")).toContain("letta permissions [--agent <id>]");
    } finally {
      console.log = originalLog;
    }
  });

  test("routes feedback help before TUI startup", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      const exitCode = await runSubcommand(["feedback", "--help"]);

      expect(exitCode).toBe(0);
      expect(messages.join("\n")).toContain("letta feedback --message <text>");
    } finally {
      console.log = originalLog;
    }
  });

  test("routes unified MCP help before TUI startup", async () => {
    const messages: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((
      chunk: string | Uint8Array,
      ...args: unknown[]
    ) => {
      messages.push(String(chunk));
      const callback = args.find((arg) => typeof arg === "function");
      if (typeof callback === "function") callback();
      return true;
    }) as typeof process.stdout.write;

    try {
      const exitCode = await runSubcommand(["mcp", "--help"]);

      expect(exitCode).toBe(0);
      expect(messages.join("\n")).toContain("letta mcp tools");
      expect(messages.join("\n")).toContain("letta mcp call");
    } finally {
      process.stdout.write = originalWrite;
    }
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

  test("routes the remote alias to the ordinary listener help", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      const exitCode = await runSubcommand(["remote", "--help"]);

      expect(exitCode).toBe(0);
      expect(messages.join("\n")).toContain(
        "Usage: letta server [--computer-name <name>]",
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

  test("does not register the removed dream subcommand", async () => {
    expect(await runSubcommand(["dream", "--help"])).toBeNull();
  });

  test("routes computers help and keeps environment aliases", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      const exitCode = await runSubcommand(["computers", "help"]);

      expect(exitCode).toBe(0);
      expect(messages.join("\n")).toContain("letta computers list");
      expect(await runSubcommand(["environments", "help"])).toBe(0);
      expect(await runSubcommand(["envs", "help"])).toBe(0);
    } finally {
      console.log = originalLog;
    }
  });

  test("routes sandbox help", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      const exitCode = await runSubcommand(["sandbox", "help"]);

      expect(exitCode).toBe(0);
      expect(messages.join("\n")).toContain("letta sandbox upload");
      expect(messages.join("\n")).toContain("letta sandbox expose <port>");
    } finally {
      console.log = originalLog;
    }
  });

  test("routes teleport help", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      const exitCode = await runSubcommand(["teleport", "help"]);

      expect(exitCode).toBe(0);
      expect(messages.join("\n")).toContain("letta teleport list");
      expect(messages.join("\n")).toContain("letta teleport cloud");
      expect(messages.join("\n")).toContain("letta teleport local");
      expect(messages.join("\n")).not.toContain("letta teleport back");
    } finally {
      console.log = originalLog;
    }
  });

  test("identifies backend-aware subcommands for early backend selection", () => {
    expect(subcommandNeedsEarlyBackendMode("app-server")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("connect")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("dream")).toBe(false);
    expect(subcommandNeedsEarlyBackendMode("server")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("computers")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("environments")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("envs")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("memory")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("mcp")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("model")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("models")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("mods")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("permissions")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("sandbox")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("teleport")).toBe(true);
    expect(subcommandNeedsEarlyBackendMode("version")).toBe(false);
    expect(subcommandNeedsEarlyBackendMode("backend")).toBe(false);
    expect(subcommandNeedsEarlyBackendMode(undefined)).toBe(false);
  });
});

const fixture: MonitorState = {
  monitor_id: "monitor-1",
  agent_id: "agent-1",
  conversation_id: "conv-test",
  kind: "github_pull_request",
  description: "Saved watch",
  command: "https://github.com/example/repo/pull/1",
  status: "paused",
  persistent: false,
  device_id: null,
  started_at: "2026-11-13T00:00:00.000Z",
  expires_at: "2026-11-14T00:00:00.000Z",
  output_file: null,
  exit_code: null,
  args: { url: "https://github.com/example/repo/pull/1" },
};

test("lists the current conversation and prints a harness tool call without starting work", async () => {
  const previous = process.env.CONVERSATION_ID;
  process.env.CONVERSATION_ID = "conv-test";
  const lines: string[] = [];
  try {
    const deps = {
      initializeSettings: async () => {},
      print: (text: string) => {
        lines.push(text);
      },
      list: async (scope: { conversation_id?: string; status?: string }) => {
        expect(scope).toMatchObject({
          conversation_id: "conv-test",
          status: "paused",
        });
        return [fixture];
      },
      read: async (id: string) => ({ ...fixture, monitor_id: id }),
    };
    expect(
      await runMonitorsSubcommand(
        ["list", "--status", "paused", "--json"],
        deps,
      ),
    ).toBe(0);
    expect(JSON.parse(lines[0] ?? "null")).toEqual([fixture]);
    expect(await runMonitorsSubcommand(["resume", "monitor-1"], deps)).toBe(0);
    expect(lines.join("\n")).toContain('WatchPR({"resume":"monitor-1"})');
    expect(lines.join("\n")).toContain("running harness");
  } finally {
    if (previous === undefined) delete process.env.CONVERSATION_ID;
    else process.env.CONVERSATION_ID = previous;
  }
});

test("agent-wide table includes status, dates, command and description", async () => {
  const lines: string[] = [];
  expect(
    await runMonitorsSubcommand(["list", "--agent", "agent-1"], {
      initializeSettings: async () => {},
      print: (text) => {
        lines.push(text);
      },
      list: async (scope) => {
        expect(scope.agent_id).toBe("agent-1");
        expect(scope.conversation_id).toBeUndefined();
        return [fixture];
      },
    }),
  ).toBe(0);
  for (const value of [
    fixture.monitor_id,
    fixture.kind,
    fixture.description,
    fixture.status,
    fixture.started_at,
    fixture.expires_at,
    fixture.command,
  ])
    expect(lines.join("\n")).toContain(value ?? "-");
});
