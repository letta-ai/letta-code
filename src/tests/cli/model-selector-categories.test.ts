import { describe, expect, test } from "bun:test";

import { getModelCategories } from "../../cli/components/ModelSelector";

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
});
