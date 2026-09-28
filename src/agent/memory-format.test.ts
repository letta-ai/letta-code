import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectMemoryFormat } from "./memory-format";

describe("memory format detection", () => {
  let memoryDir = "";

  afterEach(() => {
    if (memoryDir) rmSync(memoryDir, { recursive: true, force: true });
  });

  test("uses a root MEMORY.md marker on API and local backends", () => {
    memoryDir = mkdtempSync(join(tmpdir(), "memory-format-"));
    expect(detectMemoryFormat(memoryDir, false)).toBe("memfs-v1");
    expect(detectMemoryFormat(memoryDir, true)).toBe("memfs-v1");

    writeFileSync(join(memoryDir, "MEMORY.md"), "# Memory\n");
    expect(detectMemoryFormat(memoryDir, false)).toBe("memfs-v2");
    expect(detectMemoryFormat(memoryDir, true)).toBe("memfs-v2");
  });
});
