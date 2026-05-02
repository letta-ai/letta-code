import { describe, expect, test } from "bun:test";

import {
  getModelCategories,
  usesBackendModelCatalog,
} from "../../cli/components/ModelSelector";

describe("getModelCategories", () => {
  test("uses the same hosted category order for free and paid tiers", () => {
    expect(getModelCategories("free", false)).toEqual([
      "supported",
      "all",
      "byok",
      "byok-all",
    ]);

    expect(getModelCategories("pro", false)).toEqual([
      "supported",
      "all",
      "byok",
      "byok-all",
    ]);
  });

  test("keeps self-hosted categories unchanged", () => {
    expect(getModelCategories("free", true)).toEqual([
      "server-recommended",
      "server-all",
    ]);
  });

  test("uses server-style categories for local backend model catalogs", () => {
    expect(getModelCategories("pro", false, true)).toEqual([
      "server-recommended",
      "server-all",
    ]);
  });

  test("treats local backend catalogs as backend model catalogs", () => {
    expect(usesBackendModelCatalog(false, true)).toBe(true);
    expect(usesBackendModelCatalog(true, false)).toBe(true);
    expect(usesBackendModelCatalog(false, false)).toBe(false);
  });
});
