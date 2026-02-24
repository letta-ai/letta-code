import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("bootstrap pending-approval wiring", () => {
  test("bootstrap_session_state probes approvals via getResumeData without backfill", () => {
    const headlessPath = fileURLToPath(
      new URL("../../headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain(
      'const { getResumeData } = await import("./agent/check-approval");',
    );
    expect(source).toContain("includeMessageHistory: false");
    expect(source).toContain(
      "hasPendingApproval = (resume.pendingApprovals?.length ?? 0) > 0;",
    );
    expect(source).not.toContain(
      "hasPendingApproval: false, // TODO: wire approval state when available",
    );
  });
});
