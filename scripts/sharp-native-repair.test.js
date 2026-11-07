import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  getSharpPlatformPackages,
  repairSharpNativeBinding,
  resolveSharpRuntimePlatform,
} from "./sharp-native-repair.js";

const optionalDependencies = {
  "@img/sharp-darwin-arm64": "0.34.5",
  "@img/sharp-libvips-darwin-arm64": "1.2.4",
};

test("resolves sharp's platform package and libc-aware runtime name", () => {
  assert.equal(
    resolveSharpRuntimePlatform({ platform: "darwin", arch: "arm64" }),
    "darwin-arm64",
  );
  assert.equal(
    resolveSharpRuntimePlatform({
      platform: "linux",
      arch: "x64",
      libc: "musl",
    }),
    "linuxmusl-x64",
  );
  assert.deepEqual(
    getSharpPlatformPackages(optionalDependencies, "darwin-arm64"),
    [
      { name: "@img/sharp-darwin-arm64", version: "0.34.5" },
      { name: "@img/sharp-libvips-darwin-arm64", version: "1.2.4" },
    ],
  );
});

test("does not reinstall a present sharp binding", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "sharp-repair-test-"));
  const packageJsonPath = join(projectRoot, "sharp-package.json");
  writeFileSync(packageJsonPath, JSON.stringify({ optionalDependencies }));
  let installCalled = false;

  const result = await repairSharpNativeBinding({
    projectRoot,
    packageJsonPath,
    runtimePlatform: "darwin-arm64",
    resolveBinding: () => "present/sharp.node",
    installPackages: () => {
      installCalled = true;
    },
  });

  assert.deepEqual(result, {
    repaired: false,
    runtimePlatform: "darwin-arm64",
    reason: "binding-present",
  });
  assert.equal(installCalled, false);
});

test("installs pinned packages and verifies the repaired binding", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "sharp-repair-test-"));
  const packageJsonPath = join(projectRoot, "sharp-package.json");
  writeFileSync(packageJsonPath, JSON.stringify({ optionalDependencies }));
  const installedPackages = [];
  let bindingAvailable = false;

  const result = await repairSharpNativeBinding({
    projectRoot,
    packageJsonPath,
    runtimePlatform: "darwin-arm64",
    resolveBinding: () => (bindingAvailable ? "repaired/sharp.node" : null),
    installPackages: (packages) => {
      installedPackages.push(...packages);
      bindingAvailable = true;
    },
  });

  assert.equal(result.repaired, true);
  assert.equal(result.bindingPath, "repaired/sharp.node");
  assert.deepEqual(installedPackages, [
    { name: "@img/sharp-darwin-arm64", version: "0.34.5" },
    { name: "@img/sharp-libvips-darwin-arm64", version: "1.2.4" },
  ]);
});

test("skips runtimes without a sharp platform package", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "sharp-repair-test-"));
  const packageJsonPath = join(projectRoot, "sharp-package.json");
  writeFileSync(packageJsonPath, JSON.stringify({ optionalDependencies }));

  const result = await repairSharpNativeBinding({
    projectRoot,
    packageJsonPath,
    runtimePlatform: "freebsd-x64",
  });

  assert.deepEqual(result, {
    repaired: false,
    runtimePlatform: "freebsd-x64",
    reason: "unsupported-runtime",
  });
});
