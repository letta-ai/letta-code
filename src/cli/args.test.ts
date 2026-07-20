import { describe, expect, test } from "bun:test";
import {
  CLI_FLAG_CATALOG,
  CLI_OPTIONS,
  extractBackendFlag,
  parseBackendModeFlag,
  parseCliArgs,
  preprocessCliArgs,
  renderCliOptionsHelp,
} from "@/cli/args";

describe("shared CLI arg schema", () => {
  test("catalog is the single source of truth for parser mapping and mode support", () => {
    const catalogKeys = Object.keys(CLI_FLAG_CATALOG).sort();
    const optionKeys = Object.keys(CLI_OPTIONS).sort();
    expect(optionKeys).toEqual(catalogKeys);

    const validModes = new Set(["interactive", "headless", "both"]);
    const validTypes = new Set(["boolean", "string"]);

    for (const [flagName, definition] of Object.entries(
      CLI_FLAG_CATALOG,
    ) as Array<
      [
        keyof typeof CLI_FLAG_CATALOG,
        (typeof CLI_FLAG_CATALOG)[keyof typeof CLI_FLAG_CATALOG],
      ]
    >) {
      expect(validModes.has(definition.mode)).toBe(true);
      expect(validTypes.has(definition.parser.type)).toBe(true);
      expect(CLI_OPTIONS[flagName]).toEqual(definition.parser);
    }
  });

  test("mode lookups include shared flags and exclude opposite-mode-only flags", () => {
    const getFlagsForMode = (mode: "headless" | "interactive") =>
      Object.entries(CLI_FLAG_CATALOG)
        .filter(
          ([, definition]) =>
            definition.mode === "both" || definition.mode === mode,
        )
        .map(([name]) => name);
    const headlessFlags = getFlagsForMode("headless");
    const interactiveFlags = getFlagsForMode("interactive");

    expect(headlessFlags).toContain("memfs-startup");
    expect(headlessFlags).not.toContain("resume");
    expect(interactiveFlags).toContain("resume");
    expect(interactiveFlags).not.toContain("memfs-startup");
    expect(headlessFlags).toContain("agent");
    expect(interactiveFlags).toContain("agent");
    expect(headlessFlags).toContain("no-mods");
    expect(interactiveFlags).toContain("no-mods");
  });

  test("rendered OPTIONS help is generated from catalog metadata", () => {
    const help = renderCliOptionsHelp();
    expect(help).toContain("-h, --help");
    expect(help).toContain("--backend <mode>");
    expect(help).toContain("--no-mods");
    expect(help).toContain("LETTA_DISABLE_MODS=1 letta");
    expect(help).toContain("--memfs-startup <m>");
    expect(help).toContain("Default: text");
    expect(help).not.toContain("--run");
    expect(help).not.toContain("--dev-backend");

    for (const [flagName, definition] of Object.entries(
      CLI_FLAG_CATALOG,
    ) as Array<[string, { help?: unknown }]>) {
      if (!definition.help) continue;
      expect(help).toContain(`--${flagName}`);
    }
  });

  test("normalizes --conv alias to --conversation", () => {
    const parsed = parseCliArgs(
      preprocessCliArgs([
        "node",
        "script",
        "--conv",
        "conv-123",
        "-p",
        "hello",
      ]),
      true,
    );
    expect(parsed.values.conversation).toBe("conv-123");
    expect(parsed.positionals.slice(2).join(" ")).toBe("hello");
  });

  test("recognizes headless-specific startup flags in strict mode", () => {
    const parsed = parseCliArgs(
      preprocessCliArgs([
        "node",
        "script",
        "-p",
        "hello",
        "--memfs-startup",
        "background",
        "--pre-load-skills",
        "skill-a,skill-b",
        "--max-turns",
        "3",
        "--dev-backend",
        "fake-headless",
      ]),
      true,
    );
    expect(parsed.values["memfs-startup"]).toBe("background");
    expect(parsed.values["pre-load-skills"]).toBe("skill-a,skill-b");
    expect(parsed.values["max-turns"]).toBe("3");
    expect(parsed.values["dev-backend"]).toBe("fake-headless");
  });

  test("recognizes backend mode flag in strict mode", () => {
    const parsed = parseCliArgs(
      preprocessCliArgs(["node", "script", "--backend", "local", "-p", "hi"]),
      true,
    );
    expect(parsed.values.backend).toBe("local");
  });

  test("recognizes disable-memory-guard as a boolean flag", () => {
    const parsed = parseCliArgs(
      preprocessCliArgs([
        "node",
        "script",
        "--disable-memory-guard",
        "-p",
        "hi",
      ]),
      true,
    );
    expect(parsed.values["disable-memory-guard"]).toBe(true);
  });

  test("recognizes no-mods as a boolean recovery flag", () => {
    const parsed = parseCliArgs(
      preprocessCliArgs(["node", "script", "--no-mods", "-p", "hi"]),
      true,
    );
    expect(parsed.values["no-mods"]).toBe(true);
  });

  test("normalizes legacy no-extensions flag to no-mods", () => {
    const parsed = parseCliArgs(
      preprocessCliArgs(["node", "script", "--no-extensions", "-p", "hi"]),
      true,
    );
    expect(parsed.values["no-mods"]).toBe(true);
  });

  test("normalizes cloud backend mode and preserves the api compatibility alias", () => {
    expect(parseBackendModeFlag(undefined)).toBeUndefined();
    expect(parseBackendModeFlag("cloud")).toBe("api");
    expect(parseBackendModeFlag("api")).toBe("api");
    expect(parseBackendModeFlag("local")).toBe("local");
    expect(() => parseBackendModeFlag("server")).toThrow(
      'Invalid --backend value "server"',
    );
  });

  test("extracts and normalizes backend flags before routing subcommands", () => {
    expect(
      extractBackendFlag(["--backend", "local", "connect", "help"]),
    ).toEqual({ backend: "local", args: ["connect", "help"] });
    expect(extractBackendFlag(["connect", "help", "--backend=cloud"])).toEqual({
      backend: "api",
      args: ["connect", "help"],
    });
    expect(extractBackendFlag(["connect", "help", "--backend=api"])).toEqual({
      backend: "api",
      args: ["connect", "help"],
    });
    expect(() => extractBackendFlag(["--backend"])).toThrow(
      "Missing value for --backend",
    );
  });

  test("accepts deprecated --no-memfs as a hidden no-op (version-skew compat)", () => {
    // Older parents spawn subagents with --no-memfs; after auto-update the
    // child binary is newer than the running parent (LET-9436). The flag must
    // parse without error, do nothing, and stay out of help output.
    const parsed = parseCliArgs(
      preprocessCliArgs(["node", "script", "-p", "hello", "--no-memfs"]),
      true,
    );
    expect(parsed.values["no-memfs"]).toBe(true);
    expect(renderCliOptionsHelp()).not.toContain("--no-memfs");
  });

  test("rejects removed system-append flag in strict mode", () => {
    expect(() =>
      parseCliArgs(
        preprocessCliArgs([
          "node",
          "script",
          "-p",
          "hello",
          "--system-append",
          "extra instructions",
        ]),
        true,
      ),
    ).toThrow();
  });

  test("treats --import argument as a flag value, not prompt text", () => {
    const parsed = parseCliArgs(
      preprocessCliArgs([
        "node",
        "script",
        "-p",
        "hello",
        "--import",
        "@author/agent",
      ]),
      true,
    );
    expect(parsed.values.import).toBe("@author/agent");
    expect(parsed.positionals.slice(2).join(" ")).toBe("hello");
  });

  test("supports short aliases used by headless and interactive modes", () => {
    const parsed = parseCliArgs(
      preprocessCliArgs(["node", "script", "-p", "hello", "-C", "conv-123"]),
      true,
    );
    expect(parsed.values.conversation).toBe("conv-123");
  });
});
