import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClientDefaultHeaders } from "../../backend/api/client";
import { experimentManager } from "../../experiments/manager";
import { settingsManager } from "../../settings-manager";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalApiKey = process.env.LETTA_API_KEY;
const originalNodeFlag = process.env.LETTA_NODE;

let testHomeDir = "";

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-client-exp-home-"));
  process.env.HOME = testHomeDir;
  process.env.USERPROFILE = testHomeDir;
  process.env.LETTA_API_KEY = "test-api-key";
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

  if (originalApiKey === undefined) {
    delete process.env.LETTA_API_KEY;
  } else {
    process.env.LETTA_API_KEY = originalApiKey;
  }

  if (originalNodeFlag === undefined) {
    delete process.env.LETTA_NODE;
  } else {
    process.env.LETTA_NODE = originalNodeFlag;
  }
});

describe("getClient experiment headers", () => {
  test("uses LETTA_NODE when no explicit experiment override exists", async () => {
    process.env.LETTA_NODE = "1";

    expect(getClientDefaultHeaders()["x-letta-node"]).toBe("1");
  });

  test("sends an explicit off header when the override disables node", async () => {
    process.env.LETTA_NODE = "1";
    experimentManager.set("node", false);

    expect(getClientDefaultHeaders()["x-letta-node"]).toBe("0");
  });

  test("omits the node header when the experiment is default-off", async () => {
    expect(getClientDefaultHeaders()["x-letta-node"]).toBeUndefined();
  });
});
