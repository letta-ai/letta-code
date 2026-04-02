import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("/approve-always re-analyzes the current tool before saving", () => {
  const appPath = fileURLToPath(new URL("../../cli/App.tsx", import.meta.url));
  const source = readFileSync(appPath, "utf-8");

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
