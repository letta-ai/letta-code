import { expect, test } from "bun:test";
import {
  matchesBashPattern,
  matchesFilePattern,
  matchesToolPattern,
} from "../permissions/matcher";

// ============================================================================
// File Pattern Matching Tests
// ============================================================================

test("File pattern: exact match", () => {
  expect(
    matchesFilePattern("Read(.env)", "Read(.env)", "/Users/test/project"),
  ).toBe(true);
});

test("File pattern: glob wildcard", () => {
  expect(
    matchesFilePattern(
      "Read(.env.local)",
      "Read(.env.*)",
      "/Users/test/project",
    ),
  ).toBe(true);
  expect(
    matchesFilePattern(
      "Read(.env.production)",
      "Read(.env.*)",
      "/Users/test/project",
    ),
  ).toBe(true);
  expect(
    matchesFilePattern(
      "Read(config.json)",
      "Read(.env.*)",
      "/Users/test/project",
    ),
  ).toBe(false);
});

test("File pattern: recursive glob", () => {
  expect(
    matchesFilePattern(
      "Read(src/utils/helper.ts)",
      "Read(src/**)",
      "/Users/test/project",
    ),
  ).toBe(true);
  expect(
    matchesFilePattern(
      "Read(src/deep/nested/file.ts)",
      "Read(src/**)",
      "/Users/test/project",
    ),
  ).toBe(true);
  expect(
    matchesFilePattern(
      "Read(other/file.ts)",
      "Read(src/**)",
      "/Users/test/project",
    ),
  ).toBe(false);
});

test("File pattern: any .ts file", () => {
  expect(
    matchesFilePattern(
      "Read(src/file.ts)",
      "Read(**/*.ts)",
      "/Users/test/project",
    ),
  ).toBe(true);
  expect(
    matchesFilePattern(
      "Read(deep/nested/file.ts)",
      "Read(**/*.ts)",
      "/Users/test/project",
    ),
  ).toBe(true);
  expect(
    matchesFilePattern("Read(file.js)", "Read(**/*.ts)", "/Users/test/project"),
  ).toBe(false);
});

test("File pattern: absolute path with // prefix", () => {
  if (process.platform === "win32") return; // Skip on Windows - Unix paths

  expect(
    matchesFilePattern(
      "Read(/Users/test/docs/api.md)",
      "Read(//Users/test/docs/**)",
      "/Users/test/project",
    ),
  ).toBe(true);
});

test("File pattern: tilde expansion", () => {
  if (process.platform === "win32") return; // Skip on Windows - Unix paths

  const homedir = require("node:os").homedir();
  expect(
    matchesFilePattern(
      `Read(${homedir}/.zshrc)`,
      "Read(~/.zshrc)",
      "/Users/test/project",
    ),
  ).toBe(true);
});

test("File pattern: different tool names", () => {
  expect(
    matchesFilePattern(
      "Write(file.txt)",
      "Write(*.txt)",
      "/Users/test/project",
    ),
  ).toBe(true);
  expect(
    matchesFilePattern("Edit(file.txt)", "Edit(*.txt)", "/Users/test/project"),
  ).toBe(true);
  expect(
    matchesFilePattern("Glob(*.ts)", "Glob(*.ts)", "/Users/test/project"),
  ).toBe(true);
});

test("File pattern: tool name mismatch doesn't match", () => {
  expect(
    matchesFilePattern(
      "Read(file.txt)",
      "Write(file.txt)",
      "/Users/test/project",
    ),
  ).toBe(false);
});

test("File pattern: secrets directory", () => {
  expect(
    matchesFilePattern(
      "Read(secrets/api-key.txt)",
      "Read(secrets/**)",
      "/Users/test/project",
    ),
  ).toBe(true);
  expect(
    matchesFilePattern(
      "Read(secrets/nested/deep/file.txt)",
      "Read(secrets/**)",
      "/Users/test/project",
    ),
  ).toBe(true);
  expect(
    matchesFilePattern(
      "Read(config/secrets.txt)",
      "Read(secrets/**)",
      "/Users/test/project",
    ),
  ).toBe(false);
});

// ============================================================================
// Bash Pattern Matching Tests
// ============================================================================

test("Bash pattern: exact match", () => {
  expect(matchesBashPattern("Bash(pwd)", "Bash(pwd)")).toBe(true);
  expect(matchesBashPattern("Bash(pwd -L)", "Bash(pwd)")).toBe(false);
});

test("Bash pattern: wildcard prefix match", () => {
  expect(matchesBashPattern("Bash(git diff)", "Bash(git diff:*)")).toBe(true);
  expect(matchesBashPattern("Bash(git diff HEAD)", "Bash(git diff:*)")).toBe(
    true,
  );
  expect(
    matchesBashPattern("Bash(git diff --cached)", "Bash(git diff:*)"),
  ).toBe(true);
  expect(matchesBashPattern("Bash(git status)", "Bash(git diff:*)")).toBe(
    false,
  );
});

test("Bash pattern: npm/bun commands", () => {
  expect(matchesBashPattern("Bash(npm run lint)", "Bash(npm run lint:*)")).toBe(
    true,
  );
  expect(
    matchesBashPattern("Bash(npm run lint --fix)", "Bash(npm run lint:*)"),
  ).toBe(true);
  expect(matchesBashPattern("Bash(npm run test)", "Bash(npm run lint:*)")).toBe(
    false,
  );
});

test("Bash pattern: multi-word exact match", () => {
  expect(matchesBashPattern("Bash(npm run lint)", "Bash(npm run lint)")).toBe(
    true,
  );
  expect(
    matchesBashPattern("Bash(npm run lint --fix)", "Bash(npm run lint)"),
  ).toBe(false);
});

test("Bash pattern: git subcommands", () => {
  expect(matchesBashPattern("Bash(git push)", "Bash(git push:*)")).toBe(true);
  expect(
    matchesBashPattern("Bash(git push origin main)", "Bash(git push:*)"),
  ).toBe(true);
  expect(matchesBashPattern("Bash(git push --force)", "Bash(git push:*)")).toBe(
    true,
  );
  expect(matchesBashPattern("Bash(git pull)", "Bash(git push:*)")).toBe(false);
});

test("Bash pattern: simple commands with wildcard", () => {
  expect(matchesBashPattern("Bash(ls)", "Bash(ls:*)")).toBe(true);
  expect(matchesBashPattern("Bash(ls -la)", "Bash(ls:*)")).toBe(true);
  expect(matchesBashPattern("Bash(ls -la /tmp)", "Bash(ls:*)")).toBe(true);
  expect(matchesBashPattern("Bash(cat file.txt)", "Bash(ls:*)")).toBe(false);
});

test("Bash pattern: empty command", () => {
  expect(matchesBashPattern("Bash()", "Bash()")).toBe(true);
  expect(matchesBashPattern("Bash()", "Bash(:*)")).toBe(true);
});

test("Bash pattern: special characters in command", () => {
  expect(matchesBashPattern("Bash(echo 'hello world')", "Bash(echo:*)")).toBe(
    true,
  );
  expect(matchesBashPattern('Bash(grep -r "test" .)', "Bash(grep:*)")).toBe(
    true,
  );
});

test("Bash pattern: skill-scoped prefix matches same skill scripts", () => {
  expect(
    matchesBashPattern(
      "Bash(npx tsx /tmp/letta/src/skills/builtin/creating-skills/scripts/init-skill.ts foo)",
      "Bash(npx tsx /tmp/letta/src/skills/builtin/creating-skills:*)",
    ),
  ).toBe(true);
  expect(
    matchesBashPattern(
      "Bash(npx tsx /tmp/letta/src/skills/builtin/creating-skills/scripts/package-skill.ts bar)",
      "Bash(npx tsx /tmp/letta/src/skills/builtin/creating-skills:*)",
    ),
  ).toBe(true);
});

test("Bash pattern: skill-scoped prefix does not match other skills", () => {
  expect(
    matchesBashPattern(
      "Bash(npx tsx /tmp/letta/src/skills/builtin/messaging-agents/scripts/send.ts)",
      "Bash(npx tsx /tmp/letta/src/skills/builtin/creating-skills:*)",
    ),
  ).toBe(false);
});

// ============================================================================
// Tool Pattern Matching Tests
// ============================================================================

test("Tool pattern: exact tool name", () => {
  expect(matchesToolPattern("WebFetch", "WebFetch")).toBe(true);
  expect(matchesToolPattern("TodoWrite", "WebFetch")).toBe(false);
});

test("Tool pattern: with empty parens", () => {
  expect(matchesToolPattern("WebFetch", "WebFetch()")).toBe(true);
});

test("Tool pattern: with parens and content", () => {
  expect(matchesToolPattern("WebFetch", "WebFetch(https://example.com)")).toBe(
    true,
  );
});

test("Tool pattern: wildcard matches all", () => {
  expect(matchesToolPattern("WebFetch", "*")).toBe(true);
  expect(matchesToolPattern("Bash", "*")).toBe(true);
  expect(matchesToolPattern("Read", "*")).toBe(true);
  expect(matchesToolPattern("AnyTool", "*")).toBe(true);
});

test("Tool pattern: case sensitivity", () => {
  expect(matchesToolPattern("WebFetch", "webfetch")).toBe(false);
  expect(matchesToolPattern("WebFetch", "WebFetch")).toBe(true);
});

// ============================================================================
// Windows Path Normalization Tests (Issue #790)
// These test that backslash paths work correctly for glob matching
// ============================================================================

test("File pattern: Windows-style backslashes in pattern", () => {
  // Pattern with backslashes should match forward-slash paths
  expect(
    matchesFilePattern(
      "Edit(.skills/obsidian-mcp/scripts/foo.js)",
      "Edit(.skills\\obsidian-mcp\\scripts/**)",
      "/project",
    ),
  ).toBe(true);
});

test("File pattern: Windows-style backslashes in query", () => {
  // Query with backslashes should match forward-slash patterns
  expect(
    matchesFilePattern(
      "Edit(.skills\\obsidian-mcp\\scripts\\foo.js)",
      "Edit(.skills/obsidian-mcp/scripts/**)",
      "/project",
    ),
  ).toBe(true);
});

test("File pattern: Windows-style backslashes in both", () => {
  // Both using backslashes should still match
  expect(
    matchesFilePattern(
      "Edit(.skills\\obsidian-mcp\\scripts\\foo.js)",
      "Edit(.skills\\obsidian-mcp\\scripts\\**)",
      "/project",
    ),
  ).toBe(true);
});

test("File pattern: Edit(**) matches any path with backslashes", () => {
  // The ** glob should match everything, even with Windows paths
  // Note: minimatch requires dot:true to match dot-prefixed paths with **
  // so we test with a non-dot path here
  expect(
    matchesFilePattern(
      "Edit(skills\\obsidian-mcp\\scripts\\foo.js)",
      "Edit(**)",
      "D:\\Coding\\Project",
    ),
  ).toBe(true);
});

test("File pattern: Windows absolute path in working directory", () => {
  // Windows-style working directory should work
  expect(
    matchesFilePattern(
      "Edit(src/file.ts)",
      "Edit(src/**)",
      "D:\\Coding\\Project",
    ),
  ).toBe(true);
});
