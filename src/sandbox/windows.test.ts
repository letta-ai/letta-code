import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildFsSandboxPolicy } from "@/sandbox/policy";
import {
  buildWindowsSandboxArgs,
  ensureWindowsSandboxHelper,
  findCSharpCompiler,
  getPackagedWindowsSandboxHelperPath,
  getWindowsSandboxDevBuildPaths,
  getWindowsSandboxHelperSourcePath,
  getWindowsSandboxPlatformTag,
  WINDOWS_SANDBOX_BUILD_FROM_SOURCE_ENV,
  WINDOWS_SANDBOX_HELPER_ENV,
  WINDOWS_SANDBOX_HELPER_EXE,
} from "@/sandbox/windows";

const POLICY = buildFsSandboxPolicy({
  baseWritableRoots: ["C:/Users/me/.letta"],
  deniedRoots: ["C:/Users/me/.letta/agents"],
  readonlyRoots: ["C:/Users/me/.letta/agents/self"],
  writableRoots: ["C:/Users/me/.letta/agents/self/memory"],
  restrictWrites: true,
});

const PASSING_VALIDATE = (helperPath: string) => ({
  ok: true as const,
  helperPath,
  reason: "test self-test passed",
});

test("buildWindowsSandboxArgs renders policy roots as helper flags", () => {
  expect(buildWindowsSandboxArgs(POLICY)).toEqual([
    "--restrict-writes",
    "1",
    "--base-writable-root",
    "C:/Users/me/.letta",
    "--denied-root",
    "C:/Users/me/.letta/agents",
    "--readonly-root",
    "C:/Users/me/.letta/agents/self",
    "--writable-root",
    "C:/Users/me/.letta/agents/self/memory",
  ]);
});

test("buildWindowsSandboxArgs preserves cross-agent default-write mode", () => {
  const args = buildWindowsSandboxArgs(
    buildFsSandboxPolicy({
      deniedRoots: ["C:/Users/me/.letta/agents"],
      writableRoots: ["C:/Users/me/.letta/agents/self"],
      restrictWrites: false,
    }),
  );

  expect(args.slice(0, 2)).toEqual(["--restrict-writes", "0"]);
  expect(args).toContain("--denied-root");
  expect(args).toContain("--writable-root");
});

test("getWindowsSandboxPlatformTag supports Windows release architectures", () => {
  expect(getWindowsSandboxPlatformTag("win32", "x64")).toBe("win32-x64");
  expect(getWindowsSandboxPlatformTag("win32", "arm64")).toBe("win32-arm64");
  expect(getWindowsSandboxPlatformTag("win32", "ia32")).toBeNull();
  expect(getWindowsSandboxPlatformTag("darwin", "arm64")).toBeNull();
});

test("getPackagedWindowsSandboxHelperPath resolves the packaged helper slot", () => {
  expect(
    getPackagedWindowsSandboxHelperPath({
      packageRoot: "C:/pkg",
      platform: "win32",
      arch: "x64",
    }),
  ).toBe(
    join(
      "C:/pkg",
      "vendor",
      "windows-sandbox",
      "win32-x64",
      WINDOWS_SANDBOX_HELPER_EXE,
    ),
  );
});

test("ensureWindowsSandboxHelper uses an explicit helper override first", () => {
  const dir = mkdtempSync(join(tmpdir(), "letta-win-helper-"));
  const helper = join(dir, WINDOWS_SANDBOX_HELPER_EXE);
  writeFileSync(helper, "fake exe");

  const result = ensureWindowsSandboxHelper({
    env: { [WINDOWS_SANDBOX_HELPER_ENV]: helper },
    platform: "win32",
    arch: "x64",
    validateHelper: PASSING_VALIDATE,
  });

  expect(result).toEqual({
    ok: true,
    helperPath: helper,
    reason: `explicit ${WINDOWS_SANDBOX_HELPER_ENV} passed self-test`,
  });
});

test("ensureWindowsSandboxHelper uses packaged helper when present", () => {
  const packageRoot = mkdtempSync(join(tmpdir(), "letta-win-package-"));
  const helper = join(
    packageRoot,
    "vendor",
    "windows-sandbox",
    "win32-arm64",
    WINDOWS_SANDBOX_HELPER_EXE,
  );
  mkdirSync(dirname(helper), { recursive: true });
  writeFileSync(helper, "fake exe");

  const result = ensureWindowsSandboxHelper({
    env: {},
    packageRoot,
    platform: "win32",
    arch: "arm64",
    validateHelper: PASSING_VALIDATE,
  });

  expect(result).toEqual({
    ok: true,
    helperPath: helper,
    reason: "packaged Windows sandbox helper passed self-test",
  });
});

test("ensureWindowsSandboxHelper does not compile by default when packaged helper is missing", () => {
  const packageRoot = mkdtempSync(join(tmpdir(), "letta-win-missing-"));
  const result = ensureWindowsSandboxHelper({
    env: {},
    packageRoot,
    platform: "win32",
    arch: "x64",
    validateHelper: PASSING_VALIDATE,
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toContain("packaged Windows sandbox helper not found");
  expect(result.reason).toContain(WINDOWS_SANDBOX_BUILD_FROM_SOURCE_ENV);
});

test("dev build paths include a source hash in helper names", () => {
  const paths = getWindowsSandboxDevBuildPaths(
    "C:/Users/me",
    "C:/pkg/native/windows-sandbox/LettaWindowsSandbox.cs",
    "class Test {}",
  );

  expect(paths.dir).toBe(join("C:/Users/me", ".letta", "sandbox", "windows"));
  expect(paths.sourcePath.endsWith("LettaWindowsSandbox.cs")).toBe(true);
  expect(paths.exePath).toContain("letta-windows-sandbox-dev-");
  expect(paths.exePath.endsWith(".exe")).toBe(true);
});

test("dev fallback is explicit and reports missing source before compiler lookup", () => {
  const packageRoot = mkdtempSync(join(tmpdir(), "letta-win-dev-missing-"));
  const result = ensureWindowsSandboxHelper({
    env: { [WINDOWS_SANDBOX_BUILD_FROM_SOURCE_ENV]: "1" },
    packageRoot,
    platform: "win32",
    arch: "x64",
    validateHelper: PASSING_VALIDATE,
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toContain("source not found");
  expect(result.reason).toContain(
    getWindowsSandboxHelperSourcePath(packageRoot),
  );
});

test("findCSharpCompiler checks PATH entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "letta-csc-"));
  const compiler = join(dir, "csc.exe");
  writeFileSync(compiler, "");

  expect(findCSharpCompiler({ PATH: dir })).toBe(compiler);
});
