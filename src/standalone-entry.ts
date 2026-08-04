// Fast path: `letta git-credential` runs on every git network operation in
// memory repos, so it must not pay for the full CLI import graph (Ink,
// telemetry, providers). Dispatch it before anything else loads. Everything
// in this file must stay dynamically imported — a static import would be
// hoisted ahead of this check and defeat the bypass.
if (process.argv[2] === "git-credential") {
  const { runGitCredentialSubcommand } = await import(
    "./cli/subcommands/git-credential"
  );
  process.exit(await runGitCredentialSubcommand(process.argv.slice(3)));
}

// pi-ai keeps Node-only OAuth implementations behind bundler-opaque imports.
// Register the statically bundled loaders before the application imports any
// provider runtime so the standalone letta.js never looks for sibling files.
// This mirrors pi's standalone CLI bootstrap for the pinned pi-ai release:
// https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/bun/cli.ts#L2-L12
const { registerBunOAuthFlows } = await import(
  "@earendil-works/pi-ai/bun-oauth"
);
registerBunOAuthFlows();

await import("./index");
