import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

// pi-ai keeps Node-only OAuth implementations behind bundler-opaque imports.
// Register the statically bundled loaders before the application imports any
// provider runtime so the standalone letta.js never looks for sibling files.
// This mirrors pi's standalone CLI bootstrap for the pinned pi-ai release:
// https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/bun/cli.ts#L2-L12
registerBunOAuthFlows();

await import("./index");
