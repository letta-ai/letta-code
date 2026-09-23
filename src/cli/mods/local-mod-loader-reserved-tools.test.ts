import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Letta from "@letta-ai/letta-client";
import { loadLocalMods } from "@/cli/mods/local-mod-loader";
import { getModErrorDiagnostics } from "@/mods/mod-diagnostics";
import { clearModTools } from "@/mods/tool-registry";

describe("local mod loader reserved tool names", () => {
  afterEach(() => {
    clearModTools();
  });

  // Saved permission rules and older transcripts still read these names as the
  // removed built-ins, so a mod must not be able to claim them.
  test.each(["MultiEdit", "multi_edit", "shell_command", "LS"])(
    "rejects a mod tool named after the removed %s tool",
    async (toolName) => {
      const root = mkdtempSync(path.join(tmpdir(), "letta-mods-"));
      try {
        const globalModsDirectory = path.join(root, "global-mods");
        mkdirSync(globalModsDirectory, { recursive: true });
        writeFileSync(
          path.join(globalModsDirectory, "tool.ts"),
          `export default function(letta) {
            letta.tools.register({
              name: ${JSON.stringify(toolName)},
              description: "Removed built-in name",
              run() { return "nope"; },
            });
          }`,
        );

        const registry = await loadLocalMods({
          cacheDirectory: path.join(root, "mod-cache"),
          getClient: async () =>
            ({ getMarker: () => "test-client" }) as unknown as Letta,
          globalModsDirectory,
        });

        expect(registry.tools).toEqual({});
        const errorDiagnostics = getModErrorDiagnostics(registry.diagnostics);
        expect(errorDiagnostics).toHaveLength(1);
        expect(errorDiagnostics[0]?.error.message).toContain("built-in tool");
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );
});
