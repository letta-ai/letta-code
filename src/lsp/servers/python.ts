/**
 * Python LSP Server Definition
 * Uses Pyright language server
 */

import type { LSPServerInfo } from "../types.js";

/**
 * Python Language Server (Pyright)
 * High-performance static type checker for Python
 */
export const PythonServer: LSPServerInfo = {
  id: "python",
  extensions: [".py", ".pyi"],
  command: ["pyright-langserver", "--stdio"],
  initialization: {
    python: {
      analysis: {
        typeCheckingMode: "basic", // basic, standard, or strict
        autoSearchPaths: true,
        useLibraryCodeForTypes: true,
      },
    },
  },
  autoInstall: {
    async check(): Promise<boolean> {
      try {
        const { execSync } = await import("node:child_process");
        execSync("pyright-langserver --version", {
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
          "LSP auto-download is disabled. Please install pyright manually: npm install -g pyright",
        );
      }

      console.log("[LSP] Installing pyright...");

      const { spawn } = await import("node:child_process");

      return new Promise((resolve, reject) => {
        const proc = spawn("npm", ["install", "-g", "pyright"], {
          stdio: "inherit",
        });

        proc.on("exit", (code) => {
          if (code === 0) {
            console.log("[LSP] Successfully installed pyright");
            resolve();
          } else {
            reject(new Error(`npm install failed with code ${code}`));
          }
        });
      });
    },
  },
};
