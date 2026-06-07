import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRipgrepPath } from "@/tools/impl/ripgrep-manager";

const TOOLS_DIR_ENV = "LETTA_CODE_TOOLS_DIR";

function withTemporaryEnv<T>(
  updates: Record<string, string | undefined>,
  fn: () => T,
): T {
  const original = Object.fromEntries(
    Object.keys(updates).map((key) => [key, process.env[key]]),
  ) as Record<string, string | undefined>;

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function writeFakeRg(dir: string, name: string, body: string): string {
  const filePath = join(dir, name);
  if (process.platform === "win32") {
    writeFileSync(filePath, body, "utf-8");
  } else {
    writeFileSync(filePath, `#!/bin/sh\n${body}\n`, "utf-8");
    chmodSync(filePath, 0o755);
  }
  return filePath;
}

describe("ripgrep manager", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "letta-rg-test-"));
    tempDirs.push(dir);
    return dir;
  }

  test.skipIf(process.platform === "win32")(
    "prefers a managed rg binary that passes --version",
    () => {
      const toolsDir = makeTempDir();
      const systemDir = makeTempDir();
      const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
      const managedRg = writeFakeRg(
        toolsDir,
        binaryName,
        "echo ripgrep managed",
      );
      writeFakeRg(systemDir, binaryName, "echo ripgrep system");

      withTemporaryEnv(
        {
          [TOOLS_DIR_ENV]: toolsDir,
          PATH: systemDir,
        },
        () => {
          expect(getRipgrepPath()).toBe(managedRg);
        },
      );
    },
  );

  test.skipIf(process.platform === "win32")(
    "skips a stale managed rg binary when --version fails",
    () => {
      const toolsDir = makeTempDir();
      const systemDir = makeTempDir();
      const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
      writeFakeRg(toolsDir, binaryName, "exit 1");
      writeFakeRg(systemDir, binaryName, "echo ripgrep system");

      withTemporaryEnv(
        {
          [TOOLS_DIR_ENV]: toolsDir,
          PATH: systemDir,
        },
        () => {
          expect(getRipgrepPath()).toBe(binaryName);
        },
      );
    },
  );
});
