import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ModCacheEntryExtension,
  resolveModCacheExtension,
} from "@/mods/mod-cache-extension";

function expectExtension(
  modPath: string,
  source: string,
  expected: ModCacheEntryExtension,
): void {
  expect(resolveModCacheExtension(modPath, source)).toBe(expected);
}

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-mod-cache-extension-"));
}

test("keeps transpiled TypeScript mods on the ESM cache extension", () => {
  expectExtension("/mods/a.ts", "export default 1;", ".mjs");
  expectExtension("/mods/a.tsx", "export default 1;", ".mjs");
  expectExtension("/mods/a.ts", 'require("node:os");', ".mjs");
});

test("keeps explicit .mjs mods on the ESM cache extension", () => {
  expectExtension("/mods/a.mjs", "export default 1;", ".mjs");
  expectExtension("/mods/a.mjs", "module.exports = 1;", ".mjs");
});

test("detects a CommonJS factory in a .js mod", () => {
  expectExtension("/mods/a.js", "module.exports = 1;", ".cjs");
  expectExtension("/mods/a.js", "module.exports.activate = 1;", ".cjs");
});

test("detects named CommonJS exports in a .js mod", () => {
  expectExtension("/mods/a.js", "exports.activate = 1;", ".cjs");
});

test("detects require() in a .js mod with no export statement", () => {
  expectExtension("/mods/a.js", 'require("node:os");', ".cjs");
  expectExtension("/mods/a.js", 'const os = require("node:os");', ".cjs");
});

test("keeps ESM .js mods on the ESM cache extension", () => {
  expectExtension("/mods/a.js", "export default 1;", ".mjs");
  expectExtension("/mods/a.js", "export const a = 1;", ".mjs");
  expectExtension("/mods/a.js", 'import os from "node:os";', ".mjs");
  expectExtension("/mods/a.js", 'import "node:os";', ".mjs");
});

test("keeps the previous extension for a .js mod with no module syntax", () => {
  expectExtension("/mods/a.js", "console.log(1);", ".mjs");
});

const CJS_MOD_SOURCE = `const dep = require("fixture-dep");
const os = require("node:os");

module.exports = function activate() {
  return dep.marker + ":" + typeof os.homedir;
};
`;

function writeFixturePackage(cacheDirectory: string): void {
  const packageDirectory = path.join(
    cacheDirectory,
    "node_modules",
    "fixture-dep",
  );
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({ name: "fixture-dep", main: "index.js", version: "1.0.0" }),
  );
  writeFileSync(
    path.join(packageDirectory, "index.js"),
    'module.exports = { marker: "resolved" };\n',
  );
}

test("a CommonJS mod resolves require() from the .cjs cache entry", async () => {
  const root = createTempDir();
  try {
    const cacheDirectory = path.join(root, "mod-cache");
    mkdirSync(cacheDirectory, { recursive: true });
    writeFixturePackage(cacheDirectory);

    const extension = resolveModCacheExtension(
      "/mods/cjs-mod.js",
      CJS_MOD_SOURCE,
    );
    expect(extension).toBe(".cjs");

    const cacheEntry = path.join(
      cacheDirectory,
      `.letta-mod-cjs-mod-abc123${extension}`,
    );
    writeFileSync(cacheEntry, CJS_MOD_SOURCE, "utf8");

    const loaded = (await import(
      `${pathToFileURL(cacheEntry).href}?mod=1`
    )) as { default?: unknown };
    expect(typeof loaded.default).toBe("function");
    expect((loaded.default as () => string)()).toBe("resolved:function");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});