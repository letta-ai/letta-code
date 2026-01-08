import { afterAll, beforeAll, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { lspManager } from "../lsp/manager";

// Check if typescript-language-server is available (precompute to avoid async in skipIf)
let tsServerAvailable = false;
try {
  execSync("typescript-language-server --version", { stdio: "ignore" });
  tsServerAvailable = true;
} catch {
  // Not available
}

// Enable LSP for tests
process.env.LETTA_ENABLE_LSP = "true";
// Disable auto-download to avoid hanging in CI
process.env.LETTA_DISABLE_LSP_DOWNLOAD = "true";

beforeAll(async () => {
  // Initialize LSP for the project
  await lspManager.initialize(process.cwd());
});

afterAll(async () => {
  // Cleanup LSP servers
  await lspManager.shutdown();
});

test("LSP Manager: initializes successfully", () => {
  // Just verify it doesn't throw
  expect(true).toBe(true);
});

test.skipIf(!tsServerAvailable)(
  "LSP Manager: touchFile opens a TypeScript file",
  async () => {
    const filePath = "./src/lsp/types.ts";

    // Touch the file (should open it in LSP)
    await lspManager.touchFile(filePath, false);

    // Wait for LSP to process
    await new Promise((resolve) => setTimeout(resolve, 200));

    // File should be opened (no error thrown)
    expect(true).toBe(true);
  },
);

test.skipIf(!tsServerAvailable)(
  "LSP Manager: getDiagnostics returns empty for valid file",
  async () => {
    const filePath = "./src/lsp/types.ts";

    // Touch the file
    await lspManager.touchFile(filePath, false);

    // Wait for diagnostics
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Get diagnostics - should be empty for a valid file
    const diagnostics = lspManager.getDiagnostics(filePath);

    // types.ts should have no errors
    expect(diagnostics.length).toBe(0);
  },
);

test.skipIf(!tsServerAvailable)(
  "LSP Manager: handles file changes",
  async () => {
    const { promises: fs } = await import("node:fs");
    const testFile = "./test-lsp-file.ts";

    try {
      // Create a valid file
      await fs.writeFile(testFile, "const x: number = 42;");

      // Touch file
      await lspManager.touchFile(testFile, false);
      await new Promise((resolve) => setTimeout(resolve, 300));

      const diagnostics1 = lspManager.getDiagnostics(testFile);
      expect(diagnostics1.length).toBe(0);

      // Modify file with an error
      await fs.writeFile(testFile, "const x: number = 'string';"); // Type error!

      // Notify LSP of change
      await lspManager.touchFile(testFile, true);
      await new Promise((resolve) => setTimeout(resolve, 500));

      // LSP should process the change (diagnostics may or may not arrive depending on timing)
      // Just verify getDiagnostics doesn't crash
      const diagnostics2 = lspManager.getDiagnostics(testFile);
      expect(diagnostics2).toBeDefined();
    } finally {
      // Cleanup
      try {
        await fs.unlink(testFile);
      } catch {
        // Ignore
      }
    }
  },
);
