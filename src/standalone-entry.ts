import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

// pi-ai keeps Node-only OAuth implementations behind bundler-opaque imports.
// Register the statically bundled loaders before the application imports any
// provider runtime so the standalone letta.js never looks for sibling files.
registerBunOAuthFlows();

await import("./index");
