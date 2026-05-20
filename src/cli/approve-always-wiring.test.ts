import { expect, test } from "bun:test";
import { readInteractiveAppSource } from "@/test-utils/read-interactive-app-source";

test("/approve-always re-analyzes the current tool before saving", () => {
  const source = readInteractiveAppSource();

  const start = source.indexOf("const handleApproveAlways = useCallback(");
  const end = source.indexOf("const handleDenyCurrent = useCallback(");

  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  const segment = source.slice(start, end);

  expect(segment).toContain(
    "const currentApproval = pendingApprovals[currentIndex];",
  );
  expect(segment).toContain(
    "const latestApprovalContext = await analyzeToolApproval(",
  );
  expect(segment).toContain(
    "const rule = latestApprovalContext.recommendedRule;",
  );
  expect(segment).toContain('fail("This approval cannot be persisted.")');
  expect(segment).toContain(
    'if (rule === "Edit(**)" && actualScope === "session")',
  );
  expect(segment).toContain('setUiPermissionMode("acceptEdits");');
  expect(segment).toContain(
    'cmd.finish("Permission mode set to acceptEdits (session only)", true);',
  );
  expect(segment).not.toContain(
    "const rule = approvalContext.recommendedRule;",
  );
});
