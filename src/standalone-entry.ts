import "@/utils/startup-log-boundary";
import { tryRunMcpCli } from "@/cli/mcp-entry";

// pi-ai keeps Node-only OAuth implementations behind bundler-opaque imports.
// Register the statically bundled loaders before the application imports any
// provider runtime so the CLI uses the bundled provider implementations.
// This mirrors pi's standalone CLI bootstrap for the pinned pi-ai release:
// https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/bun/cli.ts#L2-L12
const mcpExitCode = await tryRunMcpCli(process.argv.slice(2));
if (mcpExitCode !== null) {
  process.exit(mcpExitCode);
} else {
  const { registerBunOAuthFlows } = await import(
    "@earendil-works/pi-ai/bun-oauth"
  );
  registerBunOAuthFlows();
  await import("./index");
}
