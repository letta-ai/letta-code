import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("headless approval recovery wiring", () => {
  const headlessPath = fileURLToPath(
    new URL("../../headless.ts", import.meta.url),
  );
  const source = readFileSync(headlessPath, "utf-8");

  test("main loop pre-stream catch uses extractConflictDetail (not inline extraction)", () => {
    // Find the first pre-stream catch block (main headless loop)
    const start = source.indexOf("} catch (preStreamError) {");
    expect(start).toBeGreaterThan(-1);

    // Get the catch block up to the next significant landmark
    const end = source.indexOf(
      "// Check for pending approval blocking new messages",
      start,
    );
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);

    // Should use shared extractConflictDetail, NOT inline APIError parsing
    expect(segment).toContain("extractConflictDetail(preStreamError)");
    expect(segment).not.toContain("let errorDetail = ");
  });

  test("bidirectional loop pre-stream catch uses shared extraction and router (not inline)", () => {
    // Find the second pre-stream catch block (bidirectional mode)
    const firstCatch = source.indexOf("} catch (preStreamError) {");
    const secondCatch = source.indexOf(
      "} catch (preStreamError) {",
      firstCatch + 1,
    );
    expect(secondCatch).toBeGreaterThan(firstCatch);

    // Get segment up to the throw
    const throwSite = source.indexOf("throw preStreamError;", secondCatch);
    expect(throwSite).toBeGreaterThan(secondCatch);

    const segment = source.slice(secondCatch, throwSite);

    // Should use shared extractConflictDetail, NOT inline APIError parsing
    expect(segment).toContain("extractConflictDetail(preStreamError)");
    expect(segment).not.toContain("let errorDetail = ");
    // Should use shared router, NOT bespoke isApprovalPendingError check
    expect(segment).toContain("getPreStreamErrorAction(");
    expect(segment).toContain('preStreamAction === "resolve_approval_pending"');
  });

  test("main loop pre-stream uses getPreStreamErrorAction router", () => {
    const start = source.indexOf("} catch (preStreamError) {");
    const end = source.indexOf("throw preStreamError;", start);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain("getPreStreamErrorAction(");
  });

  test("imports extractConflictDetail from approval-recovery", () => {
    expect(source).toContain("extractConflictDetail");
    // Verify it's imported, not locally defined
    const importBlock = source.slice(0, source.indexOf("export "));
    expect(importBlock).toContain("extractConflictDetail");
  });
});
