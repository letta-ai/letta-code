import { describe, expect, test } from "bun:test";
import { readInteractiveAppSource } from "@/test-utils/read-interactive-app-source";

describe("local quota fallback wiring", () => {
  test("does not auto-swap local/embedded sessions to hosted Auto", () => {
    const source = readInteractiveAppSource();
    const start = source.indexOf("const supportsHostedAutoQuotaFallback =");
    const end = source.indexOf("if (canAttemptQuotaAutoSwap) {", start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain("!getBackend().capabilities.localModelCatalog");
    expect(segment).toContain("autoSwapOnQuotaLimitEnabled &&");
    expect(segment).toContain("supportsHostedAutoQuotaFallback &&");
    expect(segment).toContain("isQuotaLimit &&");
    expect(segment).toContain("!quotaAutoSwapAttemptedRef.current");
  });
});
