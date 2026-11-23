#!/usr/bin/env bun

import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function walkFiles(root) {
  const entries = readdirSync(root);
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walkFiles(path));
      continue;
    }
    files.push(path);
  }
  return files;
}

function toDeclarationSpecifier(fromFile, targetRoot, aliasPath) {
  const targetPath = join(targetRoot, aliasPath);
  const relativePath = relative(dirname(fromFile), targetPath).replaceAll(
    "\\",
    "/",
  );
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function rewriteDeclarationAliases(typesRoot) {
  for (const file of walkFiles(typesRoot)) {
    if (!file.endsWith(".d.ts")) {
      continue;
    }
    const source = readFileSync(file, "utf-8");
    const rewritten = source.replace(
      /(["'])@\/([^"']+)\1/g,
      (_match, quote, aliasPath) =>
        `${quote}${toDeclarationSpecifier(file, typesRoot, aliasPath)}${quote}`,
    );
    if (rewritten !== source) {
      writeFileSync(file, rewritten);
    }
  }
}

const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));
const version = pkg.version;
const useMagick = Bun.env.USE_MAGICK;
const features = [];

console.log(`📦 Building Letta Code v${version}...`);
if (useMagick) {
  console.log(`🪄 Using magick variant of imageResize...`);
  features.push("USE_MAGICK");
}

await Bun.build({
  entrypoints: ["./src/standalone-entry.ts"],
  outdir: ".",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "external",
  naming: {
    entry: "letta.js",
  },
  define: {
    LETTA_VERSION: JSON.stringify(version),
    BUILD_TIME: JSON.stringify(new Date().toISOString()),
    __USE_MAGICK__: useMagick ? "true" : "false",
  },
  loader: {
    ".md": "text",
    ".mdx": "text",
    ".txt": "text",
  },
  external: [
    "ws",
    "@vscode/ripgrep",
    "node-pty",
    "grammy",
    "@pierre/diffs",
    "@pierre/diffs/*",
    "@shikijs/langs",
    "@shikijs/langs/*",
  ],
  features: features,
});

await Bun.build({
  entrypoints: ["./src/utils/image-resize-worker.ts"],
  outdir: ".",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "external",
  naming: {
    entry: "image-resize-worker.js",
  },
  external: ["sharp"],
});

await Bun.build({
  entrypoints: ["./src/image-resize-public.ts"],
  outdir: ".",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "external",
  naming: {
    entry: "image-resize.js",
  },
  define: {
    __USE_MAGICK__: "false",
  },
  external: ["sharp"],
});

await Bun.build({
  entrypoints: ["./src/tools/impl/cursor-worker.ts"],
  outdir: ".",
  target: "node",
  format: "esm",
  naming: { entry: "cursor-worker.js" },
  external: ["@cursor/sdk"],
});

const outputPath = join(__dirname, "letta.js");
let content = readFileSync(outputPath, "utf-8");

if (content.startsWith("#!")) {
  content = content.slice(content.indexOf("\n") + 1);
}

content = content.replace(
  `(()=>{throw new Error("Cannot require module "+"bun");})().secrets`,
  `globalThis.Bun.secrets`,
);

const withShebang = `#!/usr/bin/env node
${content}`;
await Bun.write(outputPath, withShebang);

if (process.platform !== "win32") {
  await Bun.$`chmod +x letta.js`;
}

await Bun.build({
  entrypoints: ["./src/app-server-client.ts"],
  outdir: "./dist",
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
  naming: {
    entry: "app-server-client.js",
  },
});

await Bun.build({
  entrypoints: ["./src/mcp-client.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "external",
  naming: {
    entry: "mcp-client.js",
  },
  define: {
    LETTA_VERSION: JSON.stringify(version),
  },
});

await Bun.build({
  entrypoints: ["./src/mcp-oauth-public.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "external",
  naming: {
    entry: "mcp-oauth.js",
  },
  define: {
    LETTA_VERSION: JSON.stringify(version),
  },
});

await Bun.build({
  entrypoints: ["./src/memory-confinement.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "external",
  naming: {
    entry: "memory-confinement.js",
  },
});

await Bun.build({
  entrypoints: ["./src/memory-constraints.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "external",
  naming: {
    entry: "memory-constraints.js",
  },
});

await Bun.build({
  entrypoints: ["./src/app-server-client.ts"],
  outdir: "./dist",
  target: "node",
  format: "cjs",
  minify: false,
  sourcemap: "external",
  naming: {
    entry: "app-server-client.cjs",
  },
});

for (const output of readdirSync(join(__dirname, "dist"))) {
  if (/^agent-presets-.+\.js(?:\.map)?$/.test(output)) {
    rmSync(join(__dirname, "dist", output));
  }
}
await Bun.build({
  entrypoints: ["./src/agent-presets.ts"],
  outdir: "./dist",
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
  splitting: true,
  naming: {
    entry: "agent-presets.js",
    chunk: "agent-presets-[name].js",
  },
  define: {
    __AGENT_PRESETS_BUNDLE__: "true",
  },
  loader: {
    ".md": "text",
    ".mdx": "text",
    ".txt": "text",
  },
});

for (const format of ["esm", "cjs"]) {
  await Bun.build({
    entrypoints: ["./src/ask-user-question.ts"],
    outdir: "./dist",
    target: "browser",
    format,
    minify: false,
    sourcemap: "external",
    naming: { entry: `ask-user-question.${format === "cjs" ? "cjs" : "js"}` },
  });
}

await Bun.build({
  entrypoints: ["./src/schedules.ts"],
  outdir: "./dist",
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
  naming: {
    entry: "schedules.js",
  },
});

await Bun.build({
  entrypoints: ["./src/channels-public.ts"],
  outdir: "./dist",
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
  naming: {
    entry: "channels-public.js",
  },
});

await Bun.build({
  entrypoints: ["./src/gateway-core.ts"],
  outdir: "./dist",
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
  naming: {
    entry: "gateway-core.js",
  },
  loader: {
    ".md": "text",
  },
});

await Bun.build({
  entrypoints: ["./src/channels-slack.ts"],
  outdir: "./dist",
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
  naming: {
    entry: "channels-slack.js",
  },
});

await Bun.build({
  entrypoints: ["./src/channels-telegram.ts"],
  outdir: "./dist",
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
  naming: {
    entry: "channels-telegram.js",
  },
});

const bundledSkillsSrc = join(__dirname, "src/skills/builtin");
const bundledSkillsDst = join(__dirname, "skills");

if (existsSync(bundledSkillsSrc)) {
  if (existsSync(bundledSkillsDst)) {
    rmSync(bundledSkillsDst, { recursive: true });
  }
  cpSync(bundledSkillsSrc, bundledSkillsDst, { recursive: true });
  console.log("📂 Copied bundled skills to skills/");
}

console.log("📝 Generating type declarations...");
await Bun.$`bunx tsc -p tsconfig.types.json`;
rewriteDeclarationAliases(join(__dirname, "dist/types"));
console.log("   Output: dist/types/protocol.d.ts");

console.log("✅ Build complete!");
console.log(`   Output: letta.js`);
console.log("   Output: dist/app-server-client.js and .cjs");
console.log(`   Size: ${(Bun.file(outputPath).size / 1024).toFixed(0)}KB`);
