import { describe, expect, test } from "bun:test";
import {
  asLegacyAppServerCommand,
  resolveServerCommand,
} from "@/cli/subcommands/server";

describe("server subcommand routing", () => {
  test("keeps the default remote environment mode", () => {
    expect(resolveServerCommand([])).toEqual({ kind: "remote", argv: [] });
    expect(resolveServerCommand(["--channels", "slack"])).toEqual({
      kind: "remote",
      argv: ["--channels", "slack"],
    });
  });

  test("uses a bare --listen flag for App Server on an available port", () => {
    expect(resolveServerCommand(["--listen"])).toEqual({
      kind: "app-server",
      argv: [],
    });
    expect(
      resolveServerCommand(["--listen", "--ws-auth", "capability-token"]),
    ).toEqual({
      kind: "app-server",
      argv: ["--ws-auth", "capability-token"],
    });
  });

  test("accepts space-separated and equals-form listen URLs", () => {
    const expected: ReturnType<typeof resolveServerCommand> = {
      kind: "app-server",
      argv: ["--listen", "ws://127.0.0.1:4500"],
    };

    expect(resolveServerCommand(["--listen", "ws://127.0.0.1:4500"])).toEqual(
      expected,
    );
    expect(resolveServerCommand(["--listen=ws://127.0.0.1:4500"])).toEqual(
      expected,
    );
  });

  test("rejects ambiguous listen arguments", () => {
    expect(() =>
      resolveServerCommand(["--listen", "--listen=ws://127.0.0.1:4500"]),
    ).toThrow("--listen may only be specified once");
    expect(() => resolveServerCommand(["--listen="])).toThrow(
      "--listen= requires a URL",
    );
  });

  test("rejects remote environment options in App Server mode", () => {
    expect(() =>
      resolveServerCommand(["--listen", "--env-name", "work-laptop"]),
    ).toThrow("--env-name cannot be used with --listen");
    expect(() =>
      resolveServerCommand(["--channels=slack", "--listen"]),
    ).toThrow("--channels cannot be used with --listen");
  });

  test("maps the legacy command to App Server mode", () => {
    expect(asLegacyAppServerCommand([])).toEqual(["--listen"]);
    expect(asLegacyAppServerCommand(["--help"])).toEqual([
      "--listen",
      "--help",
    ]);
    expect(
      asLegacyAppServerCommand(["--listen", "ws://127.0.0.1:4500"]),
    ).toEqual(["--listen", "ws://127.0.0.1:4500"]);
  });
});
