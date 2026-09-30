import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";

const appRoot = join(import.meta.dir, "..");
const outdir = join(appRoot, "dist");

await rm(outdir, { force: true, recursive: true });

const result = await Bun.build({
  entrypoints: [join(appRoot, "src", "main.ts")],
  external: ["electron", "electron-updater"],
  format: "cjs",
  minify: false,
  naming: "[name].cjs",
  outdir,
  sourcemap: "external",
  target: "node",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Sandboxed Electron preloads run with a deliberately limited CommonJS
// loader. Keep this bridge as plain CommonJS instead of wrapping it in Bun's
// bundle runtime, which Electron's preload sandbox cannot execute reliably.
await copyFile(
  join(appRoot, "src", "preload.cjs"),
  join(outdir, "preload.cjs"),
);
