import { afterEach, expect, test } from "bun:test";
import { sessionPermissions } from "../permissions/session";

afterEach(() => {
  // Clean up session state after each test
  sessionPermissions.clear();
});

// ============================================================================
// Basic Session Operations
// ============================================================================

test("Add rule to session permissions", () => {
  sessionPermissions.addRule("Bash(ls:*)", "allow");

  const rules = sessionPermissions.getRules();
  expect(rules.allow).toContain("Bash(ls:*)");
});

test("Add deny rule to session", () => {
  sessionPermissions.addRule("Read(.env)", "deny");

  const rules = sessionPermissions.getRules();
  expect(rules.deny).toContain("Read(.env)");
});

test("Add ask rule to session", () => {
  sessionPermissions.addRule("Bash(git push:*)", "ask");

  const rules = sessionPermissions.getRules();
  expect(rules.ask).toContain("Bash(git push:*)");
});

test("Add multiple rules to session", () => {
  sessionPermissions.addRule("Bash(ls:*)", "allow");
  sessionPermissions.addRule("Bash(cat:*)", "allow");
  sessionPermissions.addRule("Read(.env)", "deny");

  const rules = sessionPermissions.getRules();
  expect(rules.allow).toHaveLength(2);
  expect(rules.deny).toHaveLength(1);
});

test("Session doesn't create duplicate rules", () => {
  sessionPermissions.addRule("Bash(ls:*)", "allow");
  sessionPermissions.addRule("Bash(ls:*)", "allow");
  sessionPermissions.addRule("Bash(ls:*)", "allow");

  const rules = sessionPermissions.getRules();
  expect(rules.allow).toHaveLength(1);
});

test("hasRule checks for rule existence", () => {
  sessionPermissions.addRule("Bash(ls:*)", "allow");

  expect(sessionPermissions.hasRule("Bash(ls:*)", "allow")).toBe(true);
  expect(sessionPermissions.hasRule("Bash(cat:*)", "allow")).toBe(false);
  expect(sessionPermissions.hasRule("Bash(ls:*)", "deny")).toBe(false);
});

test("Clear removes all session rules", () => {
  sessionPermissions.addRule("Bash(ls:*)", "allow");
  sessionPermissions.addRule("Bash(cat:*)", "allow");
  sessionPermissions.addRule("Read(.env)", "deny");

  sessionPermissions.clear();

  const rules = sessionPermissions.getRules();
  expect(rules.allow).toHaveLength(0);
  expect(rules.deny).toHaveLength(0);
  expect(rules.ask).toHaveLength(0);
});

test("getRules returns a copy (not reference)", () => {
  sessionPermissions.addRule("Bash(ls:*)", "allow");

  const rules1 = sessionPermissions.getRules();
  const rules2 = sessionPermissions.getRules();

  // Should be different array instances
  expect(rules1.allow).not.toBe(rules2.allow);

  // But should have same content
  expect(rules1.allow).toEqual(rules2.allow);
});

test("Modifying returned rules doesn't affect session state", () => {
  sessionPermissions.addRule("Bash(ls:*)", "allow");

  const rules = sessionPermissions.getRules();
  rules.allow?.push("Bash(cat:*)");

  // Original session should be unchanged
  const actualRules = sessionPermissions.getRules();
  expect(actualRules.allow).toHaveLength(1);
  expect(actualRules.allow).toContain("Bash(ls:*)");
  expect(actualRules.allow).not.toContain("Bash(cat:*)");
});

// ============================================================================
// Integration with Permission Checker
// ============================================================================

test("Session rules are respected by permission checker", () => {
  // This is tested in permissions-checker.test.ts but worth verifying isolation
  sessionPermissions.addRule("Bash(custom-command:*)", "allow");

  expect(sessionPermissions.hasRule("Bash(custom-command:*)", "allow")).toBe(
    true,
  );

  sessionPermissions.clear();

  expect(sessionPermissions.hasRule("Bash(custom-command:*)", "allow")).toBe(
    false,
  );
});
