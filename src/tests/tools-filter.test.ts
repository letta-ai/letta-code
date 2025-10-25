import { afterEach, expect, test } from "bun:test";
import { toolFilter } from "../tools/filter";

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
  expect(toolFilter.isActive()).toBe(true);
});

test("No filter set means all tools enabled", () => {
  // Don't call setEnabledTools
  expect(toolFilter.isEnabled("Bash")).toBe(true);
  expect(toolFilter.isEnabled("Read")).toBe(true);
  expect(toolFilter.isEnabled("Write")).toBe(true);
  expect(toolFilter.isActive()).toBe(false);
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

test("isEnabled returns true when tool is in the list", () => {
  toolFilter.setEnabledTools("Bash,Read");

  expect(toolFilter.isEnabled("Bash")).toBe(true);
  expect(toolFilter.isEnabled("Read")).toBe(true);
});

test("isEnabled returns false when tool is NOT in the list", () => {
  toolFilter.setEnabledTools("Bash,Read");

  expect(toolFilter.isEnabled("Write")).toBe(false);
  expect(toolFilter.isEnabled("Edit")).toBe(false);
  expect(toolFilter.isEnabled("Grep")).toBe(false);
});

test("Empty string disables all tools", () => {
  toolFilter.setEnabledTools("");

  expect(toolFilter.isEnabled("Bash")).toBe(false);
  expect(toolFilter.isEnabled("Read")).toBe(false);
  expect(toolFilter.isEnabled("Write")).toBe(false);
  expect(toolFilter.isActive()).toBe(true);
});

test("Reset clears filter", () => {
  toolFilter.setEnabledTools("Bash");

  expect(toolFilter.isEnabled("Bash")).toBe(true);
  expect(toolFilter.isEnabled("Read")).toBe(false);

  toolFilter.reset();

  expect(toolFilter.isEnabled("Bash")).toBe(true);
  expect(toolFilter.isEnabled("Read")).toBe(true);
  expect(toolFilter.isActive()).toBe(false);
});

// ============================================================================
// Edge Cases
// ============================================================================

test("Ignores empty items from extra commas", () => {
  toolFilter.setEnabledTools("Bash,,Read,,,Write,");
  const tools = toolFilter.getEnabledTools();

  expect(tools).toEqual(["Bash", "Read", "Write"]);
});

test("isActive returns true when filter is set", () => {
  expect(toolFilter.isActive()).toBe(false);

  toolFilter.setEnabledTools("Bash");
  expect(toolFilter.isActive()).toBe(true);

  toolFilter.setEnabledTools("");
  expect(toolFilter.isActive()).toBe(true);
});
