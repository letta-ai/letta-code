import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimentManager } from "@/experiments/manager";
import { settingsManager } from "@/settings-manager";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPalaceFlag = process.env.LETTA_MEMORY_PALACE;

let testHomeDir = "";

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-memory-palace-home-"));
  process.env.HOME = testHomeDir;
  process.env.USERPROFILE = testHomeDir;
  delete process.env.LETTA_MEMORY_PALACE;
  await settingsManager.initialize();
});

afterEach(async () => {
  await settingsManager.reset();
  if (testHomeDir) {
    await rm(testHomeDir, { recursive: true, force: true });
    testHomeDir = "";
  }

  process.env.HOME = originalHome;
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }

  if (originalPalaceFlag === undefined) {
    delete process.env.LETTA_MEMORY_PALACE;
  } else {
    process.env.LETTA_MEMORY_PALACE = originalPalaceFlag;
  }
});

describe("memory_palace experiment", () => {
  test("is listed with a disabled default", () => {
    const snapshot = experimentManager
      .list()
      .find((entry) => entry.id === "memory_palace");

    expect(snapshot).toMatchObject({
      id: "memory_palace",
      enabled: false,
      source: "default",
      override: null,
      envVar: "LETTA_MEMORY_PALACE",
    });
  });

  test("env flag LETTA_MEMORY_PALACE=1 enables it", () => {
    process.env.LETTA_MEMORY_PALACE = "1";

    expect(experimentManager.getSnapshot("memory_palace")).toMatchObject({
      id: "memory_palace",
      enabled: true,
      source: "env",
      override: null,
    });
  });

  test("env toggle accepts 1/true/yes case-insensitively and rejects other values", () => {
    for (const value of ["1", "true", "TRUE", "Yes", " yes "]) {
      process.env.LETTA_MEMORY_PALACE = value;
      expect(experimentManager.isEnabled("memory_palace")).toBe(true);
    }

    for (const value of ["0", "false", "off", "enabled"]) {
      process.env.LETTA_MEMORY_PALACE = value;
      expect(experimentManager.isEnabled("memory_palace")).toBe(false);
    }
  });

  test("persists explicit overrides that beat the env flag", async () => {
    process.env.LETTA_MEMORY_PALACE = "1";

    expect(experimentManager.set("memory_palace", false)).toMatchObject({
      id: "memory_palace",
      enabled: false,
      source: "override",
      override: false,
    });
    await settingsManager.flush();

    await settingsManager.reset();
    await settingsManager.initialize();

    expect(experimentManager.getSnapshot("memory_palace")).toMatchObject({
      id: "memory_palace",
      enabled: false,
      source: "override",
      override: false,
    });

    expect(experimentManager.set("memory_palace", true)).toMatchObject({
      id: "memory_palace",
      enabled: true,
      source: "override",
      override: true,
    });
  });
});
