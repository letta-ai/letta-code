import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimentManager } from "@/experiments/manager";
import { settingsManager } from "@/settings-manager";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalArtifactsFlag = process.env.LETTA_ARTIFACTS;

let testHomeDir = "";

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-experiments-home-"));
  process.env.HOME = testHomeDir;
  process.env.USERPROFILE = testHomeDir;
  delete process.env.LETTA_ARTIFACTS;
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

  if (originalArtifactsFlag === undefined) {
    delete process.env.LETTA_ARTIFACTS;
  } else {
    process.env.LETTA_ARTIFACTS = originalArtifactsFlag;
  }
});

describe("experimentManager", () => {
  test("falls back to LETTA_ARTIFACTS when no override is stored", () => {
    process.env.LETTA_ARTIFACTS = "true";

    expect(experimentManager.getSnapshot("artifacts")).toMatchObject({
      id: "artifacts",
      enabled: true,
      source: "env",
      override: null,
    });
  });

  test("persists explicit overrides and lets them beat the env flag", async () => {
    process.env.LETTA_ARTIFACTS = "1";

    expect(experimentManager.set("artifacts", false)).toMatchObject({
      id: "artifacts",
      enabled: false,
      source: "override",
      override: false,
    });
    await settingsManager.flush();

    await settingsManager.reset();
    await settingsManager.initialize();

    expect(experimentManager.getSnapshot("artifacts")).toMatchObject({
      id: "artifacts",
      enabled: false,
      source: "override",
      override: false,
    });
  });

  test("does not expose the retired node experiment", () => {
    expect(
      experimentManager.list().find((entry) => entry.id === ("node" as never)),
    ).toBeUndefined();
  });

  test("maps conversation title experiment controls to the persistent setting", async () => {
    expect(experimentManager.getSnapshot("conversation_titles")).toMatchObject({
      id: "conversation_titles",
      enabled: false,
    });

    expect(experimentManager.set("conversation_titles", true)).toMatchObject({
      id: "conversation_titles",
      enabled: true,
    });
    await settingsManager.flush();

    await settingsManager.reset();
    await settingsManager.initialize();

    expect(experimentManager.getSnapshot("conversation_titles")).toMatchObject({
      id: "conversation_titles",
      enabled: true,
    });
  });
});
