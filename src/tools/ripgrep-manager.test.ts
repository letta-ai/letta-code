import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRipgrepBinDir, getRipgrepPath } from "@/tools/impl/ripgrep-manager";

const TOOLS_DIR_ENV = "LETTA_CODE_TOOLS_DIR";

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

      expect(
        getRipgrepPath({
          env: {
            ...process.env,
            [TOOLS_DIR_ENV]: toolsDir,
            PATH: systemDir,
          },
        }),
      ).toBe(managedRg);
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

      expect(
        getRipgrepPath({
          env: {
            ...process.env,
            [TOOLS_DIR_ENV]: toolsDir,
            PATH: systemDir,
          },
        }),
      ).toBe(binaryName);
    },
  );

  test.skipIf(process.platform === "win32")(
    "does not expose current directory when rg is resolved from PATH",
    () => {
      const toolsDir = makeTempDir();
      const systemDir = makeTempDir();
      const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
      writeFakeRg(systemDir, binaryName, "echo ripgrep system");

      expect(
        getRipgrepBinDir({
          env: {
            ...process.env,
            [TOOLS_DIR_ENV]: toolsDir,
            PATH: systemDir,
          },
        }),
      ).toBeUndefined();
    },
  );
});
