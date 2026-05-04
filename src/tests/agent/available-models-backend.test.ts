import { afterEach, describe, expect, test } from "bun:test";
import {
  clearAvailableModelsCache,
  getAvailableModelHandles,
} from "../../agent/available-models";
import { __testSetBackend } from "../../backend";
import { FakeHeadlessBackend } from "../../backend/dev/FakeHeadlessBackend";

describe("available models backend wiring", () => {
  afterEach(() => {
    clearAvailableModelsCache();
    __testSetBackend(null);
  });

  test("force-refresh uses the active backend model list without provider refresh for local catalogs", async () => {
    __testSetBackend(new FakeHeadlessBackend());

    const result = await getAvailableModelHandles({ forceRefresh: true });

    expect(result.source).toBe("network");
    expect(Array.from(result.handles)).toEqual(["dev/fake-headless"]);
  });
});
