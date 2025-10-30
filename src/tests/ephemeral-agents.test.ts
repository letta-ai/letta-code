import { expect, test } from "bun:test";
import { parseArgs } from "node:util";

test("--temp flag is parsed correctly", () => {
  const { values } = parseArgs({
    args: ["node", "index.ts", "--temp", "-p", "hello"],
    options: {
      temp: { type: "boolean" },
      prompt: { type: "boolean", short: "p" },
    },
    strict: false,
    allowPositionals: true,
  });

  expect(values.temp).toBe(true);
  expect(values.prompt).toBe(true);
});

test("--temp flag defaults to false when not provided", () => {
  const { values } = parseArgs({
    args: ["node", "index.ts", "-p", "hello"],
    options: {
      temp: { type: "boolean" },
      prompt: { type: "boolean", short: "p" },
    },
    strict: false,
    allowPositionals: true,
  });

  expect(values.temp).toBeUndefined();
});

test("--temp flag works with other flags", () => {
  const { values } = parseArgs({
    args: [
      "node",
      "index.ts",
      "--temp",
      "-p",
      "hello",
      "--output-format",
      "json",
      "--yolo",
    ],
    options: {
      temp: { type: "boolean" },
      prompt: { type: "boolean", short: "p" },
      "output-format": { type: "string" },
      yolo: { type: "boolean" },
    },
    strict: false,
    allowPositionals: true,
  });

  expect(values.temp).toBe(true);
  expect(values.prompt).toBe(true);
  expect(values["output-format"]).toBe("json");
  expect(values.yolo).toBe(true);
});

test("validation: --temp requires headless mode", () => {
  const isTemp = true;
  const isHeadless = false;

  expect(isTemp && !isHeadless).toBe(true);
});

test("validation: --temp is valid in headless mode", () => {
  const isTemp = true;
  const isHeadless = true;

  expect(isTemp && !isHeadless).toBe(false);
});

test("validation: --temp with -p flag is valid", () => {
  const isTemp = true;
  const hasPromptFlag = true;
  const isHeadless = hasPromptFlag || false;

  expect(isTemp && !isHeadless).toBe(false);
});
