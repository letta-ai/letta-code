import { expect, test } from "bun:test";
import { analyzeApprovalContext } from "../permissions/analyzer";
import { checkPermission } from "../permissions/checker";
import type { PermissionRules } from "../permissions/types";

test("Read within working directory is auto-allowed", () => {
  if (process.platform === "win32") return; // Skip on Windows - Unix paths
  const result = checkPermission(
    "Read",
    { file_path: "src/test.ts" },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.reason).toBe("Within working directory");
});

test("Read outside working directory requires approval", () => {
  if (process.platform === "win32") return; // Skip on Windows - Unix paths

  const result = checkPermission(
    "Read",
    { file_path: "/Users/test/other-project/file.ts" },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow"); // Default for Read tool
});

test("Bash commands require approval by default", () => {
  const result = checkPermission(
    "Bash",
    { command: "ls -la" },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );

  expect(result.decision).toBe("ask");
});

test("Allow rule matches Bash prefix pattern", () => {
  const permissions: PermissionRules = {
    allow: ["Bash(git diff:*)"],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Bash",
    { command: "git diff HEAD" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("Bash(git diff:*)");
});

test("Deny rule blocks file access", () => {
  const permissions: PermissionRules = {
    allow: [],
    deny: ["Read(.env)"],
    ask: [],
  };

  const result = checkPermission(
    "Read",
    { file_path: ".env" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("deny");
  expect(result.matchedRule).toBe("Read(.env)");
});

test("Analyze git diff approval context", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "git diff HEAD" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("Bash(git diff:*)");
  expect(context.approveAlwaysText).toContain("git diff");
  expect(context.allowPersistence).toBe(true);
  expect(context.safetyLevel).toBe("safe");
});

test("Dangerous commands don't offer persistence", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "rm -rf node_modules" },
    "/Users/test/project",
  );

  expect(context.allowPersistence).toBe(false);
  expect(context.safetyLevel).toBe("dangerous");
});

test("Read outside working directory suggests directory pattern", () => {
  if (process.platform === "win32") return; // Skip on Windows - Unix paths

  const context = analyzeApprovalContext(
    "Read",
    { file_path: "/Users/test/docs/api.md" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("Read(//Users/test/docs/**)");
  expect(context.approveAlwaysText).toContain("/Users/test/docs/");
  expect(context.defaultScope).toBe("project");
});

test("Write suggests session-only approval", () => {
  const context = analyzeApprovalContext(
    "Write",
    { file_path: "src/new-file.ts" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("Write(**)");
  expect(context.defaultScope).toBe("session");
  expect(context.approveAlwaysText).toContain("during this session");
});
