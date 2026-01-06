/**
 * TypeScript/JavaScript LSP Server Definition
 */

import type { LSPServerInfo } from "../types.js";

/**
 * TypeScript Language Server
 * Uses typescript-language-server + typescript
 */
export const TypeScriptServer: LSPServerInfo = {
  id: "typescript",
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  command: ["typescript-language-server", "--stdio"],
  initialization: {
    preferences: {
      includeInlayParameterNameHints: "all",
      includeInlayFunctionParameterTypeHints: true,
    },
  },
  autoInstall: {
    async check(): Promise<boolean> {
      try {
        const { execSync } = await import("node:child_process");
        execSync("typescript-language-server --version", {
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    },
    async install(): Promise<void> {
      if (process.env.LETTA_DISABLE_LSP_DOWNLOAD) {
        throw new Error(
          "LSP auto-download is disabled. Please install typescript-language-server manually: npm install -g typescript-language-server typescript",
        );
      }

      console.log(
        "[LSP] Installing typescript-language-server and typescript...",
      );

      const { spawn } = await import("node:child_process");

      return new Promise((resolve, reject) => {
        const proc = spawn(
          "npm",
          ["install", "-g", "typescript-language-server", "typescript"],
          {
            stdio: "inherit",
          },
        );

        proc.on("exit", (code) => {
          if (code === 0) {
            console.log(
              "[LSP] Successfully installed typescript-language-server",
            );
            resolve();
          } else {
            reject(new Error(`npm install failed with code ${code}`));
          }
        });
      });
    },
  },
};
