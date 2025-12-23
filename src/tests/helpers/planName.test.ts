import { expect, test } from "bun:test";
import { sep } from "node:path";
import {
  generatePlanFilePath,
  generatePlanName,
} from "../../cli/helpers/planName";

test("generatePlanName returns valid format", () => {
  const name = generatePlanName();
  expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
});

test("generatePlanName produces different names", () => {
  const names = new Set<string>();
  // Generate 100 names and check they're all different
  for (let i = 0; i < 100; i++) {
    names.add(generatePlanName());
  }
  // With 50 adjectives * 50 nouns * 50 adjectives combinations, we should get 100 unique names
  expect(names.size).toBe(100);
});

test("generatePlanFilePath uses platform-specific path separator", () => {
  const path = generatePlanFilePath();
  expect(path).toContain(sep);
  expect(path).toMatch(/\.letta.+plans.+/);
});

test("generatePlanFilePath ends with .md extension", () => {
  const path = generatePlanFilePath();
  expect(path).toMatch(/\.md$/);
});

test("generatePlanFilePath contains valid plan name structure", () => {
  const path = generatePlanFilePath();
  const basename = path.split(sep).pop();
  expect(basename).toMatch(/^[a-z]+-[a-z]+-[a-z]+\.md$/);
});
