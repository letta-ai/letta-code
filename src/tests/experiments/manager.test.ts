import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimentManager } from "../../experiments/manager";
import { settingsManager } from "../../settings-manager";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalNodeFlag = process.env.LETTA_NODE;

let testHomeDir = "";

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-experiments-home-"));
  process.env.HOME = testHomeDir;
  process.env.USERPROFILE = testHomeDir;
  delete process.env.LETTA_NODE;
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

  if (originalNodeFlag === undefined) {
    delete process.env.LETTA_NODE;
  } else {
    process.env.LETTA_NODE = originalNodeFlag;
  }
});

describe("experimentManager", () => {
  test("falls back to LETTA_NODE when no override is stored", () => {
    process.env.LETTA_NODE = "1";

    expect(experimentManager.getSnapshot("node")).toMatchObject({
      id: "node",
      enabled: true,
      source: "env",
      override: null,
    });
  });

  test("persists explicit overrides and lets them beat the env flag", async () => {
    process.env.LETTA_NODE = "1";

    expect(experimentManager.set("node", false)).toMatchObject({
      id: "node",
      enabled: false,
      source: "override",
      override: false,
    });
    await settingsManager.flush();

    await settingsManager.reset();
    await settingsManager.initialize();

    expect(experimentManager.getSnapshot("node")).toMatchObject({
      id: "node",
      enabled: false,
      source: "override",
      override: false,
    });
  });
});
