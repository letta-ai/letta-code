import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { PROVIDER_FALLBACK_MAP } from "@/cli/app/constants";

const headlessSource = readFileSync(
  path.resolve(import.meta.dir, "../../headless.ts"),
  "utf8",
);

describe("provider fallback maps", () => {
  test("interactive Opus 4.8 fallbacks use Bedrock Opus 4.8", () => {
    expect(PROVIDER_FALLBACK_MAP.opus).toBe("bedrock-opus-4.8");
    for (const model of [
      "opus-4.8-low",
      "opus-4.8-medium",
      "opus-4.8-high",
      "opus-4.8-xhigh",
      "opus-4.8-max",
    ]) {
      expect(PROVIDER_FALLBACK_MAP[model]).toBe("bedrock-opus-4.8");
    }
  });

  test("interactive Opus 4.7 fallbacks use Bedrock Opus 4.7", () => {
    for (const model of [
      "opus-4.7-low",
      "opus-4.7-medium",
      "opus-4.7-high",
      "opus-4.7-xhigh",
      "opus-4.7-max",
    ]) {
      expect(PROVIDER_FALLBACK_MAP[model]).toBe("bedrock-opus-4.7");
    }
  });

  test("headless Opus 4.8 fallbacks use Bedrock Opus 4.8", () => {
    expect(headlessSource).toContain('opus: "bedrock-opus-4.8"');
    for (const model of [
      "opus-4.8-low",
      "opus-4.8-medium",
      "opus-4.8-high",
      "opus-4.8-xhigh",
      "opus-4.8-max",
    ]) {
      expect(headlessSource).toContain(`"${model}": "bedrock-opus-4.8"`);
    }
  });

  test("headless Opus 4.7 fallbacks use Bedrock Opus 4.7", () => {
    for (const model of [
      "opus-4.7-low",
      "opus-4.7-medium",
      "opus-4.7-high",
      "opus-4.7-xhigh",
      "opus-4.7-max",
    ]) {
      expect(headlessSource).toContain(`"${model}": "bedrock-opus-4.7"`);
    }
  });
});
