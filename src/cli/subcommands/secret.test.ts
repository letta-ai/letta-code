import { describe, expect, test } from "bun:test";
import {
  runSecretSubcommand,
  type SecretSubcommandDeps,
} from "@/cli/subcommands/secret";

type SecretEntry = { key: string; value: string };

/** Wrap the subcommand so unit tests never touch real settings state. */
async function run(
  argv: string[],
  deps: SecretSubcommandDeps = {},
): Promise<number> {
  return runSecretSubcommand(argv, {
    initializeSettings: async () => {},
    ...deps,
  });
}

class FakeStore {
  entries = new Map<string, string>();
  calls: Array<{ op: string; key?: string; value?: string; agentId?: string }> =
    [];

  async list(agentId?: string): Promise<SecretEntry[]> {
    this.calls.push({ op: "list", agentId });
    return [...this.entries.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, value }));
  }

  async set(key: string, value: string, agentId?: string): Promise<void> {
    this.calls.push({ op: "set", key, value, agentId });
    this.entries.set(key, value);
  }

  async delete(key: string, agentId?: string): Promise<boolean> {
    this.calls.push({ op: "delete", key, agentId });
    if (!this.entries.has(key)) return false;
    this.entries.delete(key);
    return true;
  }
}

function captureConsole(): {
  out: string[];
  err: string[];
  restore: () => void;
} {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    out.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    err.push(args.map(String).join(" "));
  };
  return {
    out,
    err,
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}

async function withEnvironment<T>(
  values: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("secret subcommand", () => {
  test("set --env ingests the value from the environment and normalizes the key", async () => {
    const store = new FakeStore();
    const captured = captureConsole();
    try {
      const exit = await withEnvironment(
        { GITHUB_TOKEN: "gh-secret-value" },
        () =>
          run(["set", "github_token", "--env", "GITHUB_TOKEN"], {
            listSecrets: (id) => store.list(id),
            setSecret: (key, value, id) => store.set(key, value, id),
            deleteSecret: (key, id) => store.delete(key, id),
          }),
      );
      expect(exit).toBe(0);
      expect(store.entries.get("GITHUB_TOKEN")).toBe("gh-secret-value");
      expect(captured.out.join("\n")).toContain("$GITHUB_TOKEN");
      // The value must never be printed.
      expect(captured.out.join("\n")).not.toContain("gh-secret-value");
    } finally {
      captured.restore();
    }
  });

  test("set --env fails when the source variable is missing", async () => {
    const store = new FakeStore();
    const captured = captureConsole();
    try {
      const exit = await withEnvironment({ MISSING_VAR: undefined }, () =>
        run(["set", "KEY", "--env", "MISSING_VAR"], {
          setSecret: (key, value, id) => store.set(key, value, id),
        }),
      );
      expect(exit).toBe(1);
      expect(captured.err.join("\n")).toContain("MISSING_VAR");
      expect(store.entries.size).toBe(0);
    } finally {
      captured.restore();
    }
  });

  test("set --stdin reads piped values and strips one trailing newline", async () => {
    const store = new FakeStore();
    const captured = captureConsole();
    try {
      const exit = await run(["set", "WEBHOOK_TOKEN", "--stdin"], {
        readStdin: async () => "generated-value\n",
        setSecret: (key, value, id) => store.set(key, value, id),
      });
      expect(exit).toBe(0);
      expect(store.entries.get("WEBHOOK_TOKEN")).toBe("generated-value");
      expect(captured.out.join("\n")).not.toContain("generated-value");
    } finally {
      captured.restore();
    }
  });

  test("set rejects combining --env with --stdin or a positional value", async () => {
    const store = new FakeStore();
    const deps = { setSecret: (key: string, v: string) => store.set(key, v) };
    let exit = await run(["set", "KEY", "--env", "SRC", "--stdin"], deps);
    expect(exit).toBe(1);
    exit = await run(["set", "KEY", "positional", "--env", "SRC"], deps);
    expect(exit).toBe(1);
    expect(store.entries.size).toBe(0);
  });

  test("set with positional value succeeds but warns about exposure", async () => {
    const store = new FakeStore();
    const captured = captureConsole();
    try {
      const exit = await run(["set", "KEY", "raw-value"], {
        setSecret: (key, value, id) => store.set(key, value, id),
      });
      expect(exit).toBe(0);
      expect(captured.err.join("\n")).toContain("Warning");
    } finally {
      captured.restore();
    }
  });

  test("list prints names only and never values", async () => {
    const store = new FakeStore();
    store.entries.set("ALPHA", "alpha-secret-value");
    store.entries.set("BETA", "beta-secret-value");
    const captured = captureConsole();
    try {
      const exit = await run(["list"], {
        listSecrets: (id) => store.list(id),
      });
      expect(exit).toBe(0);
      const output = captured.out.join("\n");
      expect(output).toContain("$ALPHA");
      expect(output).toContain("$BETA");
      expect(output).not.toContain("alpha-secret-value");
      expect(output).not.toContain("beta-secret-value");
    } finally {
      captured.restore();
    }
  });

  test("unset removes an existing secret and fails on a missing one", async () => {
    const store = new FakeStore();
    store.entries.set("OLD_KEY", "old-value");
    const captured = captureConsole();
    try {
      let exit = await run(["unset", "OLD_KEY"], {
        deleteSecret: (key, id) => store.delete(key, id),
      });
      expect(exit).toBe(0);
      expect(store.entries.has("OLD_KEY")).toBe(false);

      exit = await run(["rm", "OLD_KEY"], {
        deleteSecret: (key, id) => store.delete(key, id),
      });
      expect(exit).toBe(1);
      expect(captured.err.join("\n")).toContain("not found");
    } finally {
      captured.restore();
    }
  });

  test("mutations without an agent surface resolution guidance", async () => {
    const captured = captureConsole();
    try {
      await run(["set", "KEY", "--stdin"], {
        readStdin: async () => "value",
        // Mirror the real store, which throws before writing when no agent resolves.
        setSecret: async () => {
          throw new Error("No agent context set. Agent ID is required.");
        },
      });
      expect(captured.err.join("\n")).toContain("--agent");
    } finally {
      captured.restore();
    }
  });

  test("--agent is forwarded to the store calls", async () => {
    const store = new FakeStore();
    await run(["set", "KEY", "v", "--agent", "agent-9"], {
      setSecret: (key, value, id) => store.set(key, value, id),
    });
    expect(store.calls[0]?.agentId).toBe("agent-9");

    store.entries.set("KEY", "v");
    await run(["list", "--agent", "agent-9"], {
      listSecrets: (id) => store.list(id),
    });
    expect(store.calls.at(-1)?.agentId).toBe("agent-9");
  });

  test("help exits zero; unknown verbs exit one", async () => {
    const captured = captureConsole();
    try {
      expect(await run(["help"])).toBe(0);
      expect(await run(["bogus"])).toBe(1);
    } finally {
      captured.restore();
    }
  });
});
