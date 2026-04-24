import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("interactive memfs startup wiring", () => {
  const indexPath = fileURLToPath(new URL("../../index.ts", import.meta.url));
  const source = readFileSync(indexPath, "utf-8");

  test("starts memfs setup in the background", () => {
    expect(source).toContain("const memfsSyncPromise = import(");
    expect(source).toContain("void memfsSyncPromise.catch");
    expect(source).toContain("Background startup sync failed");
    expect(source).toContain("initialLocalMemfsEnabled");
  });

  test("default conversation resume does not wait for memfs setup", () => {
    const start = source.indexOf(
      "// Load message history without blocking on memfs.",
    );
    expect(start).toBeGreaterThan(-1);

    const end = source.indexOf("setResumeData(data);", start);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain('getResumeData(client, agent, "default")');
    expect(segment).not.toContain("Promise.all");
    expect(segment).not.toContain("memfsSyncPromise");
  });

  test("explicit memfs mode changes still settle before ready", () => {
    const start = source.indexOf("if (memfsFlag || noMemfsFlag) {");
    expect(start).toBeGreaterThan(-1);

    const end = source.indexOf("// Ensure secrets cache is populated", start);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain("await memfsSyncPromise");
  });
});
