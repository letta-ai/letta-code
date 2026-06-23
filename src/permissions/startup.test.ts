import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPermission } from "@/permissions/checker";
import { resetPermissionLoaderCacheForTests } from "@/permissions/loader";
import { permissionMode } from "@/permissions/mode";
import { applyStartupPermissionMode } from "@/permissions/startup";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "letta-permission-startup-"));
  permissionMode.setMode("standard");
});

afterEach(async () => {
  resetPermissionLoaderCacheForTests();
  permissionMode.reset();
  await rm(testDir, { recursive: true, force: true });
});

test("startup applies permissions.mode from settings", async () => {
  const projectDir = join(testDir, "project-settings-mode");
  await Bun.write(
    join(projectDir, ".letta", "settings.json"),
    JSON.stringify({
      permissions: {
        mode: "bypassPermissions",
      },
    }),
  );

  const result = await applyStartupPermissionMode({
    workingDirectory: projectDir,
  });

  expect(result).toEqual({
    ok: true,
    mode: "unrestricted",
    source: "settings",
  });
  expect(permissionMode.getMode()).toBe("unrestricted");

  const permission = checkPermission(
    "Bash",
    { command: "python cache_update.py" },
    { allow: [], deny: [], ask: [] },
    projectDir,
  );
  expect(permission.decision).toBe("allow");
  expect(permission.matchedRule).toBe("unrestricted mode");
});

test("startup CLI permission mode overrides settings", async () => {
  const projectDir = join(testDir, "project-cli-mode");
  await Bun.write(
    join(projectDir, ".letta", "settings.json"),
    JSON.stringify({
      permissions: {
        mode: "standard",
      },
    }),
  );

  const result = await applyStartupPermissionMode({
    permissionModeValue: "acceptEdits",
    workingDirectory: projectDir,
  });

  expect(result).toEqual({ ok: true, mode: "acceptEdits", source: "cli" });
  expect(permissionMode.getMode()).toBe("acceptEdits");
});

test("startup yolo mode overrides explicit permission mode", async () => {
  const result = await applyStartupPermissionMode({
    permissionModeValue: "standard",
    yoloMode: true,
    workingDirectory: testDir,
  });

  expect(result).toEqual({
    ok: true,
    mode: "unrestricted",
    source: "cli",
  });
  expect(permissionMode.getMode()).toBe("unrestricted");
});

test("startup rejects invalid CLI permission mode", async () => {
  const result = await applyStartupPermissionMode({
    permissionModeValue: "banana",
    workingDirectory: testDir,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.message).toContain("Invalid permission mode: banana");
  }
  expect(permissionMode.getMode()).toBe("standard");
});
