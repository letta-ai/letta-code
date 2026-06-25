import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectSandboxBackend } from "@/sandbox/availability";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeFakeBwrap(dir: string, body: string, name = "bwrap"): string {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, name);
  writeFileSync(filePath, `#!/bin/sh\n${body}\n`, "utf-8");
  chmodSync(filePath, 0o755);
  return filePath;
}

function successfulBwrapBody(label: string): string {
  return `if [ "$1" = "--version" ]; then echo "${label}"; exit 0; fi\nexit 0`;
}

function usernsFailingBwrapBody(label: string): string {
  return `if [ "$1" = "--version" ]; then echo "${label}"; exit 0; fi\nexit 1`;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "letta-bwrap-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeBundledBwrap(packageRoot: string, body: string): string {
  return writeFakeBwrap(
    join(packageRoot, "vendor", "bwrap", "linux-x64"),
    body,
  );
}

function writeBundledManifest(packageRoot: string, sha256: string): void {
  const manifestDir = join(packageRoot, "vendor", "bwrap");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(
    join(manifestDir, "manifest.json"),
    JSON.stringify({ targets: { "linux-x64": { sha256 } } }),
  );
}

test.skipIf(process.platform === "win32")(
  "uses LETTA_BWRAP_PATH before system, PATH, or bundled bwrap",
  () => {
    const root = makeTempDir();
    const overrideDir = makeTempDir();
    const systemDir = makeTempDir();
    const override = writeFakeBwrap(
      overrideDir,
      successfulBwrapBody("override bwrap"),
    );
    const system = writeFakeBwrap(
      systemDir,
      successfulBwrapBody("system bwrap"),
    );
    writeBundledBwrap(root, successfulBwrapBody("bundled bwrap"));

    const result = detectSandboxBackend({
      platform: "linux",
      architecture: "x64",
      env: { LETTA_BWRAP_PATH: override, PATH: "" },
      systemBwrapPath: system,
      bundledRoot: root,
      expectedBundledSha256: sha256Hex(
        `#!/bin/sh\n${successfulBwrapBody("bundled bwrap")}\n`,
      ),
      force: true,
    });

    expect(result.backend).toBe("bwrap");
    expect(result.bwrapPath).toBe(override);
    expect(result.reason).toBe("LETTA_BWRAP_PATH override available");
  },
);

test.skipIf(process.platform === "win32")(
  "prefers the system bwrap path over PATH and bundled resources",
  () => {
    const root = makeTempDir();
    const systemDir = makeTempDir();
    const pathDir = makeTempDir();
    const system = writeFakeBwrap(
      systemDir,
      successfulBwrapBody("system bwrap"),
    );
    writeFakeBwrap(pathDir, successfulBwrapBody("PATH bwrap"));
    writeBundledBwrap(root, successfulBwrapBody("bundled bwrap"));

    const result = detectSandboxBackend({
      platform: "linux",
      architecture: "x64",
      env: { PATH: pathDir },
      systemBwrapPath: system,
      bundledRoot: root,
      expectedBundledSha256: sha256Hex(
        `#!/bin/sh\n${successfulBwrapBody("bundled bwrap")}\n`,
      ),
      force: true,
    });

    expect(result.backend).toBe("bwrap");
    expect(result.bwrapPath).toBe(system);
    expect(result.reason).toBe("system bwrap available");
  },
);

test.skipIf(process.platform === "win32")(
  "uses PATH bwrap before bundled resources when no system path exists",
  () => {
    const root = makeTempDir();
    const pathDir = makeTempDir();
    const pathBwrap = writeFakeBwrap(
      pathDir,
      successfulBwrapBody("PATH bwrap"),
    );
    writeBundledBwrap(root, successfulBwrapBody("bundled bwrap"));

    const result = detectSandboxBackend({
      platform: "linux",
      architecture: "x64",
      env: { PATH: pathDir },
      systemBwrapPath: null,
      bundledRoot: root,
      expectedBundledSha256: sha256Hex(
        `#!/bin/sh\n${successfulBwrapBody("bundled bwrap")}\n`,
      ),
      force: true,
    });

    expect(result.backend).toBe("bwrap");
    expect(result.bwrapPath).toBe(pathBwrap);
    expect(result.reason).toBe("PATH bwrap available");
  },
);

test.skipIf(process.platform === "win32")(
  "falls back to a bundled bwrap when system and PATH bwrap are missing",
  () => {
    const root = makeTempDir();
    const bundledBody = successfulBwrapBody("bundled bwrap");
    const bundled = writeBundledBwrap(root, bundledBody);
    writeBundledManifest(root, sha256Hex(`#!/bin/sh\n${bundledBody}\n`));

    const result = detectSandboxBackend({
      platform: "linux",
      architecture: "x64",
      env: { PATH: "" },
      systemBwrapPath: null,
      bundledRoot: root,
      force: true,
    });

    expect(result.backend).toBe("bwrap");
    expect(result.bwrapPath).toBe(bundled);
    expect(result.reason).toBe("bundled bwrap available");
  },
);

test.skipIf(process.platform === "win32")(
  "rejects a bundled bwrap with a mismatched SHA-256",
  () => {
    const root = makeTempDir();
    writeBundledBwrap(root, successfulBwrapBody("bundled bwrap"));

    const result = detectSandboxBackend({
      platform: "linux",
      architecture: "x64",
      env: { PATH: "" },
      systemBwrapPath: null,
      bundledRoot: root,
      expectedBundledSha256: "0".repeat(64),
      force: true,
    });

    expect(result.backend).toBeNull();
    expect(result.reason).toContain("bundled bwrap SHA-256 mismatch");
  },
);

test.skipIf(process.platform === "win32")(
  "does not fall back to bundled bwrap when system bwrap cannot create user namespaces",
  () => {
    const root = makeTempDir();
    const systemDir = makeTempDir();
    const system = writeFakeBwrap(
      systemDir,
      usernsFailingBwrapBody("system bwrap"),
    );
    const bundledBody = successfulBwrapBody("bundled bwrap");
    writeBundledBwrap(root, bundledBody);

    const result = detectSandboxBackend({
      platform: "linux",
      architecture: "x64",
      env: { PATH: "" },
      systemBwrapPath: system,
      bundledRoot: root,
      expectedBundledSha256: sha256Hex(`#!/bin/sh\n${bundledBody}\n`),
      force: true,
    });

    expect(result.backend).toBeNull();
    expect(result.reason).toBe(
      "system bwrap present but user namespaces are unavailable",
    );
  },
);
