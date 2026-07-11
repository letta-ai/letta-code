import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClientDefaultHeaders } from "@/backend/api/client";
import type { Settings } from "@/settings-manager";
import { settingsManager } from "@/settings-manager";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalApiKey = process.env.LETTA_API_KEY;
const originalNodeFlag = process.env.LETTA_NODE;
const originalMemfsBackend = process.env.LETTA_MEMFS_BACKEND;

let testHomeDir = "";

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-client-exp-home-"));
  process.env.HOME = testHomeDir;
  process.env.USERPROFILE = testHomeDir;
  process.env.LETTA_API_KEY = "test-api-key";
  delete process.env.LETTA_NODE;
  delete process.env.LETTA_MEMFS_BACKEND;
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

  if (originalMemfsBackend === undefined) {
    delete process.env.LETTA_MEMFS_BACKEND;
  } else {
    process.env.LETTA_MEMFS_BACKEND = originalMemfsBackend;
  }
});

describe("getClient experiment headers", () => {
  test("sends the node header when LETTA_NODE is enabled", async () => {
    process.env.LETTA_NODE = "1";

    expect(getClientDefaultHeaders()["x-letta-node"]).toBe("1");
  });

  test("sends an explicit off header when LETTA_NODE is set but disabled", async () => {
    process.env.LETTA_NODE = "0";

    expect(getClientDefaultHeaders()["x-letta-node"]).toBe("0");
  });

  test("omits the node header when LETTA_NODE is unset", async () => {
    expect(getClientDefaultHeaders()["x-letta-node"]).toBeUndefined();
  });

  test("ignores a persisted legacy node experiment override", async () => {
    // Stale `experiments: { node: false }` settings (LET-9516) must not
    // produce an opt-out header anymore.
    // "node" is intentionally no longer a valid ExperimentId; simulate the
    // legacy on-disk shape that older builds persisted.
    settingsManager.updateSettings({
      experiments: { node: false },
    } as unknown as Partial<Settings>);

    expect(getClientDefaultHeaders()["x-letta-node"]).toBeUndefined();
  });

  test("sends hosted backend header when requested", async () => {
    process.env.LETTA_MEMFS_BACKEND = "hosted";

    expect(getClientDefaultHeaders()["x-letta-memfs-backend"]).toBe("hosted");
  });
});
