import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  parseGitCredentialInput,
  requestMatchesLettaHost,
  runGitCredentialSubcommand,
} from "@/cli/subcommands/git-credential";

describe("parseGitCredentialInput", () => {
  test("parses key=value lines and stops at the blank line", () => {
    expect(
      parseGitCredentialInput(
        "protocol=https\nhost=api.letta.com\npath=v1/git/agent-1/state.git\n\nusername=ignored\n",
      ),
    ).toEqual({
      protocol: "https",
      host: "api.letta.com",
      path: "v1/git/agent-1/state.git",
    });
  });

  test("keeps '=' inside values and skips malformed lines", () => {
    expect(
      parseGitCredentialInput("host=localhost:8283\nnoequals\n=empty\na=b=c\n"),
    ).toEqual({ host: "localhost:8283", a: "b=c" });
  });

  test("handles empty input", () => {
    expect(parseGitCredentialInput("")).toEqual({});
  });
});

describe("requestMatchesLettaHost", () => {
  test("matches the configured host, with and without port", () => {
    expect(
      requestMatchesLettaHost(
        { host: "api.letta.com" },
        "https://api.letta.com",
      ),
    ).toBe(true);
    expect(
      requestMatchesLettaHost(
        { host: "localhost:8283" },
        "http://localhost:8283",
      ),
    ).toBe(true);
  });

  test("rejects other hosts, missing hosts, and bad base URLs", () => {
    expect(
      requestMatchesLettaHost({ host: "github.com" }, "https://api.letta.com"),
    ).toBe(false);
    expect(requestMatchesLettaHost({}, "https://api.letta.com")).toBe(false);
    expect(requestMatchesLettaHost({ host: "api.letta.com" }, "")).toBe(false);
  });
});

describe("runGitCredentialSubcommand", () => {
  let stdout: string[] = [];
  let stderr: string[] = [];
  const originalWrite = process.stdout.write;
  const originalError = console.error;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    process.stdout.write = ((chunk: string) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    console.error = (...args: unknown[]) => {
      stderr.push(args.join(" "));
    };
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    console.error = originalError;
  });

  const deps = (overrides: Record<string, unknown> = {}) => ({
    resolveBaseUrl: async () => "https://api.letta.com",
    resolveToken: async () => "fresh-token",
    input: "protocol=https\nhost=api.letta.com\n\n",
    ...overrides,
  });

  test("get prints the credential for the Letta host", async () => {
    const code = await runGitCredentialSubcommand(["get"], deps());
    expect(code).toBe(0);
    expect(stdout.join("")).toBe("username=letta\npassword=fresh-token\n");
  });

  test("get stays silent for foreign hosts", async () => {
    const code = await runGitCredentialSubcommand(
      ["get"],
      deps({ input: "protocol=https\nhost=github.com\n\n" }),
    );
    expect(code).toBe(0);
    expect(stdout.join("")).toBe("");
  });

  test("get stays silent when unauthenticated", async () => {
    const code = await runGitCredentialSubcommand(
      ["get"],
      deps({ resolveToken: async () => "" }),
    );
    expect(code).toBe(0);
    expect(stdout.join("")).toBe("");
  });

  test("store and erase are silent no-ops", async () => {
    for (const action of ["store", "erase"]) {
      const code = await runGitCredentialSubcommand(
        [action],
        deps({ input: "host=api.letta.com\npassword=whatever\n\n" }),
      );
      expect(code).toBe(0);
    }
    expect(stdout.join("")).toBe("");
  });

  test("unknown action fails with usage", async () => {
    const code = await runGitCredentialSubcommand(["frobnicate"], deps());
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("Usage");
  });

  test("fails fast when token resolution exceeds the deadline", async () => {
    const code = await runGitCredentialSubcommand(
      ["get"],
      deps({
        deadlineMs: 20,
        resolveToken: () =>
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("late"), 5_000),
          ),
      }),
    );
    expect(code).toBe(1);
    expect(stdout.join("")).toBe("");
    expect(stderr.join("\n")).toContain("timed out");
  });

  test("fails without echoing secrets when resolution throws", async () => {
    const code = await runGitCredentialSubcommand(
      ["get"],
      deps({
        resolveToken: async () => {
          throw new Error("keychain unavailable");
        },
      }),
    );
    expect(code).toBe(1);
    expect(stdout.join("")).toBe("");
    expect(stderr.join("\n")).toContain("keychain unavailable");
  });
});
