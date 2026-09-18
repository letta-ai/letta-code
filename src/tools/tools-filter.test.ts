import { afterEach, expect, test } from "bun:test";
import { toolFilter } from "@/tools/filter";

// Clean up after each test
afterEach(() => {
  toolFilter.reset();
});

// ============================================================================
// Tool Filter Parsing Tests
// ============================================================================

test("Parse simple tool list", () => {
  toolFilter.setEnabledTools("Bash,Read,Write");
  const tools = toolFilter.getEnabledTools();

  expect(tools).toEqual(["Bash", "Read", "Write"]);
});

test("Parse empty string means no tools", () => {
  toolFilter.setEnabledTools("");
  const tools = toolFilter.getEnabledTools();

  expect(tools).toEqual([]);
});

test("No filter set means all tools enabled", () => {
  // Don't call setEnabledTools
  expect(toolFilter.getEnabledTools()).toBe(null);
});

test("Handle whitespace in tool list", () => {
  toolFilter.setEnabledTools(" Bash , Read , Write ");
  const tools = toolFilter.getEnabledTools();

  expect(tools).toEqual(["Bash", "Read", "Write"]);
});

test("Handle single tool", () => {
  toolFilter.setEnabledTools("Bash");
  const tools = toolFilter.getEnabledTools();

  expect(tools).toEqual(["Bash"]);
});

// ============================================================================
// Tool Filtering Tests
// ============================================================================

test("Reset clears filter", () => {
  toolFilter.setEnabledTools("Bash");
  expect(toolFilter.getEnabledTools()).toEqual(["Bash"]);
  toolFilter.reset();
  expect(toolFilter.getEnabledTools()).toBeNull();
});

// ============================================================================
// Edge Cases
// ============================================================================

test("Ignores empty items from extra commas", () => {
  toolFilter.setEnabledTools("Bash,,Read,,,Write,");
  const tools = toolFilter.getEnabledTools();

  expect(tools).toEqual(["Bash", "Read", "Write"]);
});
