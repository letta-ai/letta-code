import { describe, expect, test } from "bun:test";
import { readInteractiveAppSource } from "@/tests/helpers/readInteractiveAppSource";

describe("resize redraw wiring", () => {
  test("does not define lossy static-item resize cap", () => {
    const source = readInteractiveAppSource();

    expect(source).not.toContain("MAX_STATIC_ITEMS_ON_RESIZE");
  });

  test("clearAndRemount redraws without mutating staticItems", () => {
    const source = readInteractiveAppSource();

    const anchor = "const clearAndRemount = useCallback(";
    const start = source.indexOf(anchor);
    expect(start).toBeGreaterThanOrEqual(0);

    const end = source.indexOf(
      "const scheduleResizeClear = useCallback(",
      start,
    );
    expect(end).toBeGreaterThan(start);

    const block = source.slice(start, end);
    expect(block).toContain("setStaticRenderEpoch((epoch) => epoch + 1);");
    expect(block).not.toContain("setStaticItems(");
  });
});
