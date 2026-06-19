import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildFsSandboxPolicy } from "@/sandbox/policy";
import {
  buildWindowsSandboxArgs,
  findCSharpCompiler,
  getWindowsSandboxHelperPaths,
} from "@/sandbox/windows";

const POLICY = buildFsSandboxPolicy({
  baseWritableRoots: ["C:/Users/me/.letta"],
  deniedRoots: ["C:/Users/me/.letta/agents"],
  readonlyRoots: ["C:/Users/me/.letta/agents/self"],
  writableRoots: ["C:/Users/me/.letta/agents/self/memory"],
  restrictWrites: true,
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

test("getWindowsSandboxHelperPaths includes the source hash in helper names", () => {
  const paths = getWindowsSandboxHelperPaths("C:/Users/me");
  expect(paths.dir).toBe(join("C:/Users/me", ".letta", "sandbox", "windows"));
  expect(paths.sourcePath.endsWith(".cs")).toBe(true);
  expect(paths.exePath.endsWith(".exe")).toBe(true);
  expect(paths.sourcePath).not.toBe(paths.exePath);
});

test("findCSharpCompiler checks PATH entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "letta-csc-"));
  const compiler = join(dir, "csc.exe");
  writeFileSync(compiler, "");

  expect(findCSharpCompiler({ PATH: dir })).toBe(compiler);
});
