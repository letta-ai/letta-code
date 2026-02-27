import { expect, test } from "bun:test";
import { analyzeApprovalContext } from "../permissions/analyzer";

// ============================================================================
// Bash Command Analysis Tests
// ============================================================================

test("Git diff suggests safe subcommand rule", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "git diff HEAD" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("Bash(git diff:*)");
  expect(context.approveAlwaysText).toContain("git diff");
  expect(context.allowPersistence).toBe(true);
  expect(context.safetyLevel).toBe("safe");
  expect(context.defaultScope).toBe("project");
});

test("Git status suggests safe subcommand rule", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "git status" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("Bash(git status:*)");
  expect(context.safetyLevel).toBe("safe");
});

test("Git push suggests moderate safety rule", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "git push origin main" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("Bash(git push:*)");
  expect(context.approveAlwaysText).toContain("git push");
  expect(context.allowPersistence).toBe(true);
  expect(context.safetyLevel).toBe("moderate");
  expect(context.defaultScope).toBe("project");
});

test("Git pull suggests moderate safety rule", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "git pull origin main" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("Bash(git pull:*)");
  expect(context.safetyLevel).toBe("moderate");
});

test("Git commit suggests moderate safety rule", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "git commit -m 'test'" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("Bash(git commit:*)");
  expect(context.safetyLevel).toBe("moderate");
});

test("Dangerous rm command blocks persistence", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "rm -rf node_modules" },
    "/Users/test/project",
  );

  expect(context.allowPersistence).toBe(false);
  expect(context.safetyLevel).toBe("dangerous");
  expect(context.approveAlwaysText).toBe("");
});

test("Dangerous mv command blocks persistence", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "mv file.txt /tmp/" },
    "/Users/test/project",
  );

  expect(context.allowPersistence).toBe(false);
  expect(context.safetyLevel).toBe("dangerous");
});

test("Dangerous chmod command blocks persistence", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "chmod 777 file.txt" },
    "/Users/test/project",
  );

  expect(context.allowPersistence).toBe(false);
  expect(context.safetyLevel).toBe("dangerous");
});

test("Dangerous sudo command blocks persistence", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "sudo apt-get install vim" },
    "/Users/test/project",
  );

  expect(context.allowPersistence).toBe(false);
  expect(context.safetyLevel).toBe("dangerous");
});

test("Command with --force flag blocks persistence", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "git push --force origin main" },
    "/Users/test/project",
  );

  expect(context.allowPersistence).toBe(false);
  expect(context.safetyLevel).toBe("dangerous");
});

test("Command with --hard flag blocks persistence", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "git reset --hard HEAD" },
    "/Users/test/project",
  );

  expect(context.allowPersistence).toBe(false);
  expect(context.safetyLevel).toBe("dangerous");
});

test("npm run commands suggest safe rule", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "npm run test" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("Bash(npm run test:*)");
  expect(context.approveAlwaysText).toContain("npm run test");
  expect(context.safetyLevel).toBe("safe");
  expect(context.defaultScope).toBe("project");
});

test("bun run commands suggest safe rule", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "bun run lint" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("Bash(bun run lint:*)");
  expect(context.safetyLevel).toBe("safe");
});

test("yarn commands suggest safe rule", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "yarn test" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("Bash(yarn test:*)");
  expect(context.safetyLevel).toBe("safe");
});

test("Safe ls command suggests wildcard rule", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "ls -la /tmp" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("Bash(ls:*)");
  expect(context.approveAlwaysText).toContain("ls");
  expect(context.safetyLevel).toBe("safe");
});

test("Safe cat command suggests wildcard rule", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "cat file.txt" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("Bash(cat:*)");
  expect(context.safetyLevel).toBe("safe");
});

test("Unknown command suggests exact match", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "custom-script --arg value" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("Bash(custom-script --arg value)");
  expect(context.safetyLevel).toBe("moderate");
  expect(context.allowPersistence).toBe(true);
});

test("Wrapped shell launcher suggests unwrapped read-only wildcard rule", () => {
  const context = analyzeApprovalContext(
    "Bash",
    {
      command: "bash -lc \"sed -n '150,360p' src/permissions/mode.ts\"",
    },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("Bash(sed -n:*)");
  expect(context.approveAlwaysText).toContain("sed -n");
});

test("Read-only rg command suggests wildcard rule", () => {
  const context = analyzeApprovalContext(
    "Bash",
    { command: "rg -n analyzeBashApproval src/permissions/analyzer.ts" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("Bash(rg:*)");
  expect(context.safetyLevel).toBe("safe");
});

test("Skill script in bundled skill suggests bundled-scope message", () => {
  if (process.platform === "win32") return;

  const context = analyzeApprovalContext(
    "Bash",
    {
      command:
        "cd /Users/test/project && npx tsx /tmp/letta/src/skills/builtin/creating-skills/scripts/init-skill.ts my-skill",
    },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe(
    "Bash(cd /Users/test/project && npx tsx /tmp/letta/src/skills/builtin/creating-skills:*)",
  );
  expect(context.approveAlwaysText).toBe(
    "Yes, and don't ask again for scripts in bundled skill 'creating-skills'",
  );
  expect(context.safetyLevel).toBe("moderate");
});

test("Skill script in agent-scoped skill suggests agent-scoped message", () => {
  if (process.platform === "win32") return;
  const home = require("node:os").homedir();

  const context = analyzeApprovalContext(
    "Bash",
    {
      command: `npx tsx ${home}/.letta/agents/agent-123/skills/finding-agents/scripts/main.ts --help`,
    },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe(
    `Bash(npx tsx ${home}/.letta/agents/agent-123/skills/finding-agents:*)`,
  );
  expect(context.approveAlwaysText).toBe(
    "Yes, and don't ask again for scripts in agent-scoped skill 'finding-agents'",
  );
});

test("Skill script in global skill suggests global message", () => {
  if (process.platform === "win32") return;
  const home = require("node:os").homedir();

  const context = analyzeApprovalContext(
    "Bash",
    {
      command: `npx tsx ${home}/.letta/skills/messaging-agents/scripts/run.ts`,
    },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe(
    `Bash(npx tsx ${home}/.letta/skills/messaging-agents:*)`,
  );
  expect(context.approveAlwaysText).toBe(
    "Yes, and don't ask again for scripts in global skill 'messaging-agents'",
  );
});

test("Skill script in project skill supports nested skill IDs", () => {
  if (process.platform === "win32") return;

  const context = analyzeApprovalContext(
    "Bash",
    {
      command:
        "npx tsx /Users/test/project/.skills/workflow/agent-tools/scripts/do.ts",
    },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe(
    "Bash(npx tsx /Users/test/project/.skills/workflow/agent-tools:*)",
  );
  expect(context.approveAlwaysText).toBe(
    "Yes, and don't ask again for scripts in project skill 'workflow/agent-tools'",
  );
});

test("Dangerous skill script command still blocks persistence", () => {
  if (process.platform === "win32") return;

  const context = analyzeApprovalContext(
    "Bash",
    {
      command:
        "npx tsx /tmp/letta/src/skills/builtin/creating-skills/scripts/init-skill.ts --force",
    },
    "/Users/test/project",
  );

  expect(context.allowPersistence).toBe(false);
  expect(context.safetyLevel).toBe("dangerous");
});

test("Skill script path in quoted command is detected", () => {
  if (process.platform === "win32") return;

  const context = analyzeApprovalContext(
    "Bash",
    {
      command:
        "bash -lc \"npx tsx '/tmp/letta/src/skills/builtin/creating-skills/scripts/package-skill.ts'\"",
    },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toContain(
    "/tmp/letta/src/skills/builtin/creating-skills:*",
  );
  expect(context.approveAlwaysText).toBe(
    "Yes, and don't ask again for scripts in bundled skill 'creating-skills'",
  );
});

// ============================================================================
// File Tool Analysis Tests
// ============================================================================

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
  expect(context.safetyLevel).toBe("safe");
});

test("Read with tilde path shows tilde in button text", () => {
  const homedir = require("node:os").homedir();
  const context = analyzeApprovalContext(
    "Read",
    { file_path: `${homedir}/.zshrc` },
    "/Users/test/project",
  );

  expect(context.approveAlwaysText).toContain("~/");
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
  expect(context.safetyLevel).toBe("moderate");
});

test("Edit suggests directory pattern for project-level", () => {
  if (process.platform === "win32") return; // Skip on Windows - Unix paths

  const context = analyzeApprovalContext(
    "Edit",
    { file_path: "src/utils/helper.ts" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("Edit(src/utils/**)");
  expect(context.approveAlwaysText).toContain("src/utils/");
  expect(context.defaultScope).toBe("project");
  expect(context.safetyLevel).toBe("safe");
});

test("Edit at project root suggests project pattern", () => {
  if (process.platform === "win32") return; // Skip on Windows - Unix paths

  const context = analyzeApprovalContext(
    "Edit",
    { file_path: "README.md" },
    "/Users/test/project",
  );

  expect(context.approveAlwaysText).toContain("project");
  expect(context.safetyLevel).toBe("safe");
});

test("Glob outside working directory suggests directory pattern", () => {
  if (process.platform === "win32") return; // Skip on Windows - Unix paths

  const context = analyzeApprovalContext(
    "Glob",
    { path: "/Users/test/docs" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toContain("Glob(//Users/test/docs/**)");
  expect(context.approveAlwaysText).toContain("/Users/test/docs/");
});

test("Grep outside working directory suggests directory pattern", () => {
  if (process.platform === "win32") return; // Skip on Windows - Unix paths

  const context = analyzeApprovalContext(
    "Grep",
    { path: "/Users/test/docs" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toContain("Grep(//Users/test/docs/**)");
  expect(context.approveAlwaysText).toContain("/Users/test/docs/");
});

test("Read outside Windows working directory emits canonical Windows absolute rule", () => {
  const context = analyzeApprovalContext(
    "Read",
    { file_path: "C:\\Users\\Test\\docs\\api.md" },
    "C:\\Users\\Test\\project",
  );

  expect(context.recommendedRule).toBe("Read(C:/Users/Test/docs/**)");
  expect(context.approveAlwaysText).toContain("C:/Users/Test/docs/");
});

test("Edit outside Windows working directory emits canonical Windows absolute rule", () => {
  const context = analyzeApprovalContext(
    "Edit",
    { file_path: "C:\\Users\\Test\\docs\\note.md" },
    "C:\\Users\\Test\\project",
  );

  expect(context.recommendedRule).toBe("Edit(C:/Users/Test/docs/**)");
  expect(context.approveAlwaysText).toContain("C:/Users/Test/docs/");
});

test("Read inside Windows working directory handles drive-letter case differences", () => {
  const context = analyzeApprovalContext(
    "Read",
    { file_path: "c:\\users\\test\\project\\src\\index.ts" },
    "C:\\Users\\Test\\project",
  );

  expect(context.recommendedRule).toBe("Read(src/**)");
});

test("Glob outside Windows working directory emits canonical Windows absolute rule", () => {
  const context = analyzeApprovalContext(
    "Glob",
    { path: "C:\\Users\\Test\\docs" },
    "C:\\Users\\Test\\project",
  );

  expect(context.recommendedRule).toBe("Glob(C:/Users/Test/docs/**)");
  expect(context.approveAlwaysText).toContain("C:/Users/Test/docs/");
});

test("Grep outside Windows working directory emits canonical Windows absolute rule", () => {
  const context = analyzeApprovalContext(
    "Grep",
    { path: "C:\\Users\\Test\\docs" },
    "C:\\Users\\Test\\project",
  );

  expect(context.recommendedRule).toBe("Grep(C:/Users/Test/docs/**)");
  expect(context.approveAlwaysText).toContain("C:/Users/Test/docs/");
});

// ============================================================================
// WebFetch Analysis Tests
// ============================================================================

test("WebFetch suggests domain pattern", () => {
  const context = analyzeApprovalContext(
    "WebFetch",
    { url: "https://api.github.com/users/test" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("WebFetch(https://api.github.com/*)");
  expect(context.approveAlwaysText).toContain("api.github.com");
  expect(context.safetyLevel).toBe("safe");
});

test("WebFetch with http protocol", () => {
  const context = analyzeApprovalContext(
    "WebFetch",
    { url: "http://localhost:3000/api" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("WebFetch(http://localhost/*)");
  expect(context.approveAlwaysText).toContain("localhost");
});

test("WebFetch with invalid URL falls back", () => {
  const context = analyzeApprovalContext(
    "WebFetch",
    { url: "not-a-valid-url" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("WebFetch");
  expect(context.safetyLevel).toBe("moderate");
});

// ============================================================================
// Default/Unknown Tool Analysis Tests
// ============================================================================

test("Unknown tool suggests session-only", () => {
  const context = analyzeApprovalContext(
    "CustomTool",
    { arg: "value" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("CustomTool");
  expect(context.defaultScope).toBe("session");
  expect(context.safetyLevel).toBe("moderate");
});

// ============================================================================
// Long Command Bugs
// ============================================================================

test("Long complex bash commands should generate smart wildcard patterns", () => {
  // Bug: When command is >40 chars, analyzer saves exact match instead of wildcard
  // Example: "cd /path && git diff file.ts | head -100"
  // Should generate: "Bash(cd /path && git diff:*)" to also match "... | tail -30"

  const longCommand =
    "cd /Users/test/project && git diff src/file.ts | head -100";

  const context = analyzeApprovalContext(
    "Bash",
    { command: longCommand },
    "/Users/test/project",
  );

  // Should extract "git diff" pattern, not save full command
  expect(context.recommendedRule).toBe("Bash(git diff:*)");
  // Button text should reflect the wildcard pattern
  expect(context.approveAlwaysText).not.toContain("...");
});

test("Very long non-git commands should generate prefix-based wildcards", () => {
  // For commands that don't match known patterns (npm, git, etc)
  // we should still be smarter than exact match
  const longCommand = "cd /Users/test/project && npm run lint 2>&1 | tail -20";

  const context = analyzeApprovalContext(
    "Bash",
    { command: longCommand },
    "/Users/test/project",
  );

  // Should generate wildcard for "npm run lint"
  expect(context.recommendedRule).toBe("Bash(npm run lint:*)");
  expect(context.approveAlwaysText).toContain("npm run lint");
});

test("WriteFileGemini uses write-family wildcard rule", () => {
  const context = analyzeApprovalContext(
    "WriteFileGemini",
    { file_path: "src/main.ts", content: "console.log('hi');" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("Write(**)");
  expect(context.defaultScope).toBe("session");
});

test("run_shell_command is analyzed as Bash", () => {
  const context = analyzeApprovalContext(
    "run_shell_command",
    { command: "curl -s http://localhost:4321/intro" },
    "/Users/test/project",
  );

  expect(context.recommendedRule).toBe("Bash(curl:*)");
});
