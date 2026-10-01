import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClientDefaultHeaders } from "@/backend/api/client";
import { settingsManager } from "@/settings-manager";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalApiKey = process.env.LETTA_API_KEY;
const originalMemfsBackend = process.env.LETTA_MEMFS_BACKEND;

let testHomeDir = "";

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-client-exp-home-"));
  process.env.HOME = testHomeDir;
  process.env.USERPROFILE = testHomeDir;
  process.env.LETTA_API_KEY = "test-api-key";
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

  if (originalMemfsBackend === undefined) {
    delete process.env.LETTA_MEMFS_BACKEND;
  } else {
    process.env.LETTA_MEMFS_BACKEND = originalMemfsBackend;
  }
});

describe("getClient experiment headers", () => {
  test("sends hosted backend header when requested", () => {
    process.env.LETTA_MEMFS_BACKEND = "hosted";

    expect(getClientDefaultHeaders()["x-letta-memfs-backend"]).toBe("hosted");
  });
});
