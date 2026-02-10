import { describe, expect, test } from "bun:test";

import { getModelInfoForLlmConfig } from "../agent/model";

describe("getModelInfoForLlmConfig", () => {
  test("selects gpt-5.2 tier by reasoning_effort", () => {
    const handle = "openai/gpt-5.2";

    const high = getModelInfoForLlmConfig(handle, { reasoning_effort: "high" });
    expect(high?.id).toBe("gpt-5.2-high");

    const none = getModelInfoForLlmConfig(handle, { reasoning_effort: "none" });
    expect(none?.id).toBe("gpt-5.2-none");

    const xhigh = getModelInfoForLlmConfig(handle, {
      reasoning_effort: "xhigh",
    });
    expect(xhigh?.id).toBe("gpt-5.2-xhigh");
  });

  test("falls back to first handle match when effort missing", () => {
    const handle = "openai/gpt-5.2";
    const info = getModelInfoForLlmConfig(handle, null);
    // models.json order currently lists gpt-5.2-none first.
    expect(info?.id).toBe("gpt-5.2-none");
  });
});
