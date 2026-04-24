import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function source(relativePath: string): string {
  const path = fileURLToPath(
    new URL(`../../tools/impl/${relativePath}`, import.meta.url),
  );
  return readFileSync(path, "utf-8");
}

function appSource(): string {
  const path = fileURLToPath(new URL("../../cli/App.tsx", import.meta.url));
  return readFileSync(path, "utf-8");
}

describe("lazy memfs checkout wiring", () => {
  test("memory tools ensure local checkout before resolving the repo", () => {
    expect(source("Memory.ts")).toContain("ensureScopedMemoryDirReady");
    expect(source("Memory.ts")).toContain("await resolveMemoryDir()");

    expect(source("MemoryApplyPatch.ts")).toContain(
      "ensureScopedMemoryDirReady",
    );
    expect(source("MemoryApplyPatch.ts")).toContain("await resolveMemoryDir()");
  });

  test("file tools ensure checkout before touching memory paths", () => {
    const files = [
      "ApplyPatch.ts",
      "Edit.ts",
      "Glob.ts",
      "Grep.ts",
      "ListDirCodex.ts",
      "LS.ts",
      "ReadFileCodex.ts",
      "Read.ts",
      "Write.ts",
    ];

    for (const file of files) {
      expect(source(file)).toContain("ensureMemfsCheckoutForPath");
    }
  });

  test("shell tools ensure checkout before commands that reference memory", () => {
    expect(source("Bash.ts")).toContain("ensureMemfsCheckoutForShellCommand");
    expect(source("ShellCommand.ts")).toContain(
      "ensureMemfsCheckoutForShellCommand",
    );
    expect(source("Shell.ts")).toContain("ensureMemfsCheckoutForShellCommand");
    expect(appSource()).toContain("ensureMemfsCheckoutForShellCommand");
  });
});
