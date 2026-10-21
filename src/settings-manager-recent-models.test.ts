import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsManager } from "@/settings-manager";

const originalHome = process.env.HOME;
let testHomeDir: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-recent-models-test-"));
  process.env.HOME = testHomeDir;
});

afterEach(async () => {
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

describe("Settings Manager - Recent models", () => {
  test("deduplicates and caps recent models at ten entries", async () => {
    await settingsManager.initialize();

    for (let index = 1; index <= 12; index += 1) {
      settingsManager.addRecentModel(`model-${index}`);
    }
    settingsManager.addRecentModel("model-5");

    expect(settingsManager.getRecentModels()).toEqual([
      "model-5",
      "model-12",
      "model-11",
      "model-10",
      "model-9",
      "model-8",
      "model-7",
      "model-6",
      "model-4",
      "model-3",
    ]);
  });
});
