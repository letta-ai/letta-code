import { afterEach, expect, test } from "bun:test";
import { checkPermission } from "../permissions/checker";
import { cliPermissions } from "../permissions/cli";
import type { PermissionRules } from "../permissions/types";

// Clean up after each test
afterEach(() => {
  cliPermissions.clear();
});

// ============================================================================
// CLI Permission Parsing Tests
// ============================================================================

test("Parse simple tool list", () => {
  cliPermissions.setAllowedTools("Bash,Read,Write");
  const tools = cliPermissions.getAllowedTools();

  // Bash is normalized to Bash(:*), file tools get (**) wildcard
  expect(tools).toEqual(["Bash(:*)", "Read(**)", "Write(**)"]);
});

test("Parse tool list with parameters", () => {
  cliPermissions.setAllowedTools("Bash(npm install),Read(src/**)");
  const tools = cliPermissions.getAllowedTools();

  expect(tools).toEqual(["Bash(npm install)", "Read(src/**)"]);
});

test("Parse tool list with mixed formats", () => {
  cliPermissions.setAllowedTools("Bash,Read(src/**),Write");
  const tools = cliPermissions.getAllowedTools();

  expect(tools).toEqual(["Bash(:*)", "Read(src/**)", "Write(**)"]);
});

test("Parse tool list with wildcards", () => {
  cliPermissions.setAllowedTools("Bash(git diff:*),Bash(npm run test:*)");
  const tools = cliPermissions.getAllowedTools();

  expect(tools).toEqual(["Bash(git diff:*)", "Bash(npm run test:*)"]);
});

test("Handle empty tool list", () => {
  cliPermissions.setAllowedTools("");
  const tools = cliPermissions.getAllowedTools();

  expect(tools).toEqual([]);
});

test("Handle whitespace in tool list", () => {
  cliPermissions.setAllowedTools("Bash , Read , Write");
  const tools = cliPermissions.getAllowedTools();

  expect(tools).toEqual(["Bash(:*)", "Read(**)", "Write(**)"]);
});

// ============================================================================
// CLI allowedTools Override Tests
// ============================================================================

test("allowedTools overrides settings deny rules", () => {
  cliPermissions.setAllowedTools("Bash");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Bash",
    { command: "npm install" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("Bash(:*) (CLI)");
  expect(result.reason).toBe("Matched --allowedTools flag");
});

test("allowedTools with pattern matches specific command", () => {
  cliPermissions.setAllowedTools("Bash(npm install)");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Bash",
    { command: "npm install" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("Bash(npm install) (CLI)");
});

test("allowedTools pattern does not match different command", () => {
  cliPermissions.setAllowedTools("Bash(npm install)");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Bash",
    { command: "rm -rf /" },
    permissions,
    "/Users/test/project",
  );

  // Should not match, fall back to default behavior
  expect(result.decision).toBe("ask");
  expect(result.reason).toBe("Default behavior for tool");
});

test("allowedTools with wildcard prefix matches multiple commands", () => {
  cliPermissions.setAllowedTools("Bash(npm run test:*)");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result1 = checkPermission(
    "Bash",
    { command: "npm run test:unit" },
    permissions,
    "/Users/test/project",
  );
  expect(result1.decision).toBe("allow");

  const result2 = checkPermission(
    "Bash",
    { command: "npm run test:integration" },
    permissions,
    "/Users/test/project",
  );
  expect(result2.decision).toBe("allow");

  const result3 = checkPermission(
    "Bash",
    { command: "npm run lint" },
    permissions,
    "/Users/test/project",
  );
  expect(result3.decision).toBe("ask"); // Should not match
});

test("allowedTools applies to multiple tools", () => {
  cliPermissions.setAllowedTools("Bash,Read,Write");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const bashResult = checkPermission(
    "Bash",
    { command: "ls" },
    permissions,
    "/Users/test/project",
  );
  expect(bashResult.decision).toBe("allow");

  const readResult = checkPermission(
    "Read",
    { file_path: "/etc/passwd" },
    permissions,
    "/Users/test/project",
  );
  expect(readResult.decision).toBe("allow");

  const writeResult = checkPermission(
    "Write",
    { file_path: "/tmp/test.txt" },
    permissions,
    "/Users/test/project",
  );
  expect(writeResult.decision).toBe("allow");
});

// ============================================================================
// CLI disallowedTools Override Tests
// ============================================================================

test("disallowedTools denies tool", () => {
  cliPermissions.setDisallowedTools("WebFetch");

  const permissions: PermissionRules = {
    allow: ["WebFetch"],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "WebFetch",
    { url: "https://example.com" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("deny");
  expect(result.matchedRule).toBe("WebFetch (CLI)");
  expect(result.reason).toBe("Matched --disallowedTools flag");
});

test("disallowedTools with pattern denies specific command", () => {
  cliPermissions.setDisallowedTools("Bash(curl:*)");

  const permissions: PermissionRules = {
    allow: ["Bash"],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Bash",
    { command: "curl https://malicious.com" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("deny");
  expect(result.matchedRule).toBe("Bash(curl:*) (CLI)");
});

test("disallowedTools overrides settings allow rules", () => {
  cliPermissions.setDisallowedTools("Bash");

  const permissions: PermissionRules = {
    allow: ["Bash"],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Bash",
    { command: "ls" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("deny");
  expect(result.reason).toBe("Matched --disallowedTools flag");
});

test("disallowedTools does NOT override settings deny rules", () => {
  cliPermissions.setAllowedTools("Bash");

  const permissions: PermissionRules = {
    allow: [],
    deny: ["Bash(rm -rf:*)"],
    ask: [],
  };

  const result = checkPermission(
    "Bash",
    { command: "rm -rf /" },
    permissions,
    "/Users/test/project",
  );

  // Settings deny should take precedence
  expect(result.decision).toBe("deny");
  expect(result.reason).toBe("Matched deny rule");
  expect(result.matchedRule).toBe("Bash(rm -rf:*)");
});

// ============================================================================
// Combined allowedTools and disallowedTools Tests
// ============================================================================

test("disallowedTools takes precedence over allowedTools", () => {
  cliPermissions.setAllowedTools("Bash");
  cliPermissions.setDisallowedTools("Bash(curl:*)");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  // curl should be denied
  const curlResult = checkPermission(
    "Bash",
    { command: "curl https://example.com" },
    permissions,
    "/Users/test/project",
  );
  expect(curlResult.decision).toBe("deny");

  // other commands should be allowed
  const lsResult = checkPermission(
    "Bash",
    { command: "ls" },
    permissions,
    "/Users/test/project",
  );
  expect(lsResult.decision).toBe("allow");
});

test("allowedTools and disallowedTools with multiple tools", () => {
  cliPermissions.setAllowedTools("Bash,Read");
  cliPermissions.setDisallowedTools("Write");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const bashResult = checkPermission(
    "Bash",
    { command: "ls" },
    permissions,
    "/Users/test/project",
  );
  expect(bashResult.decision).toBe("allow");

  const readResult = checkPermission(
    "Read",
    { file_path: "/tmp/file.txt" },
    permissions,
    "/Users/test/project",
  );
  expect(readResult.decision).toBe("allow");

  const writeResult = checkPermission(
    "Write",
    { file_path: "/tmp/file.txt" },
    permissions,
    "/Users/test/project",
  );
  expect(writeResult.decision).toBe("deny");
});

// ============================================================================
// Precedence Tests
// ============================================================================

test("Precedence: settings deny > CLI disallowedTools", () => {
  cliPermissions.setDisallowedTools("Bash(npm:*)");

  const permissions: PermissionRules = {
    allow: [],
    deny: ["Bash(curl:*)"],
    ask: [],
  };

  // Settings deny should match first
  const result = checkPermission(
    "Bash",
    { command: "curl https://example.com" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("deny");
  expect(result.matchedRule).toBe("Bash(curl:*)");
  expect(result.reason).toBe("Matched deny rule");
});

test("Precedence: CLI allowedTools > settings allow", () => {
  cliPermissions.setAllowedTools("Bash(npm install)");

  const permissions: PermissionRules = {
    allow: ["Bash(docker:*)"],
    deny: [],
    ask: [],
  };

  // CLI should match for npm install
  const npmResult = checkPermission(
    "Bash",
    { command: "npm install" },
    permissions,
    "/Users/test/project",
  );
  expect(npmResult.decision).toBe("allow");
  expect(npmResult.matchedRule).toBe("Bash(npm install) (CLI)");

  // Settings should match for docker (non-read-only command)
  const dockerResult = checkPermission(
    "Bash",
    { command: "docker build ." },
    permissions,
    "/Users/test/project",
  );
  expect(dockerResult.decision).toBe("allow");
  expect(dockerResult.matchedRule).toBe("Bash(docker:*)");
});
