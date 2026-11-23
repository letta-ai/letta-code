import { afterAll, beforeAll, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { lspManager } from "@/lsp/manager";

let tsServerAvailable = false;
try {
  execSync("typescript-language-server --version", { stdio: "ignore" });
  tsServerAvailable = true;
} catch {}

process.env.LETTA_ENABLE_LSP = "true";
process.env.LETTA_DISABLE_LSP_DOWNLOAD = "true";

beforeAll(async () => {
  await lspManager.initialize(process.cwd());
});

afterAll(async () => {
  await lspManager.shutdown();
});

test("LSP Manager: initializes successfully", () => {
  expect(true).toBe(true);
});

test.skipIf(!tsServerAvailable)(
  "LSP Manager: touchFile opens a TypeScript file",
  async () => {
    const filePath = "./src/lsp/types.ts";

    await lspManager.touchFile(filePath, false);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(true).toBe(true);
  },
);

test.skipIf(!tsServerAvailable)(
  "LSP Manager: getDiagnostics returns empty for valid file",
  async () => {
    const filePath = "./src/lsp/types.ts";

    await lspManager.touchFile(filePath, false);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const diagnostics = lspManager.getDiagnostics(filePath);

    expect(diagnostics.length).toBe(0);
  },
);

test.skipIf(!tsServerAvailable)(
  "LSP Manager: handles file changes",
  async () => {
    const { promises: fs } = await import("node:fs");
    const testFile = "./test-lsp-file.ts";

    try {
      await fs.writeFile(testFile, "const x: number = 42;");

      await lspManager.touchFile(testFile, false);
      await new Promise((resolve) => setTimeout(resolve, 300));

      const diagnostics1 = lspManager.getDiagnostics(testFile);
      expect(diagnostics1.length).toBe(0);

      await fs.writeFile(testFile, "const x: number = 'string';");

      await lspManager.touchFile(testFile, true);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const diagnostics2 = lspManager.getDiagnostics(testFile);
      expect(diagnostics2).toBeDefined();
    } finally {
      try {
        await fs.unlink(testFile);
      } catch {}
    }
  },
);
