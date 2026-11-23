import { afterEach, expect, test } from "bun:test";
import { toolFilter } from "@/tools/filter";

afterEach(() => {
  toolFilter.reset();
});

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

test("Reset clears filter", () => {
  toolFilter.setEnabledTools("Bash");
  expect(toolFilter.getEnabledTools()).toEqual(["Bash"]);
  toolFilter.reset();
  expect(toolFilter.getEnabledTools()).toBeNull();
});

test("Ignores empty items from extra commas", () => {
  toolFilter.setEnabledTools("Bash,,Read,,,Write,");
  const tools = toolFilter.getEnabledTools();

  expect(tools).toEqual(["Bash", "Read", "Write"]);
});
