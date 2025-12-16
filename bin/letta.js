#!/usr/bin/env node

/**
 * Unified entry point for the Letta CLI.
 * Detects the platform and spawns the appropriate compiled binary.
 *
 * Note: Uses #!/usr/bin/env node (not bun) for maximum compatibility
 * when users install via npm/npx. Bun can still run this file.
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { platform, arch } = process;

// Map platform/arch to binary name
let binaryName = null;
switch (platform) {
  case "linux":
    switch (arch) {
      case "x64":
        binaryName = "letta-linux-x64";
        break;
      case "arm64":
        binaryName = "letta-linux-arm64";
        break;
    }
    break;
  case "darwin":
    switch (arch) {
      case "x64":
        binaryName = "letta-macos-x64";
        break;
      case "arm64":
        binaryName = "letta-macos-arm64";
        break;
    }
    break;
  case "win32":
    switch (arch) {
      case "x64":
        binaryName = "letta-windows-x64.exe";
        break;
    }
    break;
}

if (!binaryName) {
  console.error(`Error: Unsupported platform: ${platform} ${arch}`);
  console.error("Supported platforms:");
  console.error("  - macOS: arm64, x64");
  console.error("  - Linux: arm64, x64");
  console.error("  - Windows: x64");
  process.exit(1);
}

const binaryPath = path.join(__dirname, binaryName);

// Spawn the binary with all arguments
const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
  env: process.env,
});

// Forward signals to child process
function forwardSignal(signal) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

forwardSignal("SIGINT");
forwardSignal("SIGTERM");

// Exit with the same code as the child process
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code || 0);
  }
});
